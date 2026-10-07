// Streams raw microphone PCM to the Python alignment service (server/main.py's /ws/align) for
// Matchmaker score following.
//
// Deliberately separate from audio/captureModule: this path performs NO analysis at all. The
// worklet here only counts samples into hop-sized chunks and posts them out, so alignment delivery
// can't be delayed by pitch-detection work, and there's no framing to get wrong (captureModule
// emits OVERLAPPING analysis windows, which are not interchangeable with the fresh, contiguous
// chunks BytesAudioStream expects -- forwarding one as the other corrupts every feature frame).
//
// A previous integration did tap captureModule's frames, and both of its live failures came from
// that coupling: the wrong slice of each window was forwarded, and when the pitch pipeline fell
// behind real time, chunks stopped reaching the socket entirely.

import type { AlignmentPoint } from "../practice/offlineIntonationScorer";

const WORKLET_NAME = "matchmaker-hop-collector";

export type MatchmakerStreamStatus =
  | "idle"
  | "connecting"
  | "preparing_score"
  | "waiting_for_sound"
  | "streaming"
  | "completed"
  | "error";

export interface MatchmakerStreamOptions {
  // Raw-signal RMS below which the microphone is considered silent. Meant to be the capture
  // module's calibrated silenceRmsThreshold, which is measured on the same ungained signal this
  // stream carries. See the gating comment in start() for why this exists.
  silenceRmsThreshold: number;
  // How long after the level last cleared the threshold audio keeps being sent. Bridges the dips
  // that are part of playing -- a bow change, a note's decay tail, a breath between phrases -- so
  // only a genuine pause closes the gate. Default 400ms.
  gateHoldMs?: number;
}

export interface MatchmakerStreamDiagnostics {
  status: MatchmakerStreamStatus;
  // True while audio is being sent. False before the first sound and during any pause longer
  // than gateHoldMs; the tracker holds its position for as long as this is false.
  gateOpen: boolean;
  chunksDropped: number;
  chunksSent: number;
  // Server-side verdicts on what was sent: a frame is "rejected" when it doesn't resemble any
  // nearby part of the score (noise, a wrong note) and is ignored so the position holds.
  framesAccepted: number;
  framesRejected: number;
  positionsReceived: number;
  hopLength: number | null;
  sampleRate: number | null;
  totalQuarters: number | null;
  lastQuarter: number | null;
  lastLatencyMs: number | null;
  error: string | null;
}

export interface MatchmakerStreamCallbacks {
  onPosition: (quarter: number) => void;
  onStatus?: (status: MatchmakerStreamStatus) => void;
  onCompleted?: () => void;
  onError?: (message: string) => void;
  // The server's post-practice global alignment of the whole take -- see
  // practice/offlineIntonationScorer.ts. Arrives after the take ends, at most once.
  onOfflineAlignment?: (path: AlignmentPoint[]) => void;
  // The socket is gone, for any reason other than a hard stop(). If no offline alignment came
  // first, none is coming.
  onClosed?: () => void;
}

interface ReadyMessage {
  status: "ready";
  hopLength: number;
  totalQuarters: number;
}

function buildWorkletSource(): string {
  return `
    class HopCollectorProcessor extends AudioWorkletProcessor {
      constructor(options) {
        super();
        this.hopLength = options.processorOptions.hopLength;
        this.buffer = new Float32Array(this.hopLength);
        this.offset = 0;
      }

      process(inputs) {
        const input = inputs[0];
        if (!input || input.length === 0 || input[0].length === 0) {
          return true;
        }

        const channel = input[0];
        let index = 0;
        while (index < channel.length) {
          const toCopy = Math.min(this.hopLength - this.offset, channel.length - index);
          this.buffer.set(channel.subarray(index, index + toCopy), this.offset);
          this.offset += toCopy;
          index += toCopy;

          if (this.offset === this.hopLength) {
            this.port.postMessage(this.buffer.slice());
            this.offset = 0;
          }
        }

        return true;
      }
    }

    registerProcessor(${JSON.stringify(WORKLET_NAME)}, HopCollectorProcessor);
  `;
}

function rms(samples: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) {
    sum += samples[i] * samples[i];
  }
  return Math.sqrt(sum / Math.max(1, samples.length));
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export class MatchmakerStream {
  private socket: WebSocket | null = null;
  private audioContext: AudioContext | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private clonedStream: MediaStream | null = null;
  private workletModuleUrl: string | null = null;
  private callbacks: MatchmakerStreamCallbacks | null = null;
  private stopped = false;
  // Every chunk actually sent, in order. The server keeps the identical sequence
  // (LiveAligner.push_chunk), so both ends share one recording timeline -- the offline alignment
  // the server computes is expressed in times that index straight into this buffer.
  private recordedChunks: Float32Array[] = [];

  private diagnostics: MatchmakerStreamDiagnostics = {
    status: "idle",
    gateOpen: false,
    chunksDropped: 0,
    chunksSent: 0,
    framesAccepted: 0,
    framesRejected: 0,
    positionsReceived: 0,
    hopLength: null,
    sampleRate: null,
    totalQuarters: null,
    lastQuarter: null,
    lastLatencyMs: null,
    error: null
  };

  getDiagnostics(): MatchmakerStreamDiagnostics {
    return { ...this.diagnostics };
  }

  /**
   * Opens the socket, waits for the server to finish preparing the score, then starts streaming.
   * Resolves once audio is actually flowing, so callers can keep the UI honest about the
   * (multi-second) score-preparation step instead of pretending practice already started.
   */
  async start(
    mediaStream: MediaStream,
    scoreXml: string,
    callbacks: MatchmakerStreamCallbacks,
    options: MatchmakerStreamOptions
  ): Promise<void> {
    this.callbacks = callbacks;
    this.stopped = false;
    this.recordedChunks = [];
    this.diagnostics.gateOpen = false;
    this.diagnostics.chunksDropped = 0;
    this.setStatus("connecting");

    const scoreHash = await sha256Hex(scoreXml);

    // Cloning rather than using the stream directly: a MediaStreamAudioSourceNode takes ownership
    // of the tracks it's given for its own context's graph, and captureModule's context is already
    // using them.
    this.clonedStream = mediaStream.clone();
    const audioContext = new AudioContext();
    this.audioContext = audioContext;
    this.diagnostics.sampleRate = audioContext.sampleRate;

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${window.location.host}/ws/align`);
    socket.binaryType = "arraybuffer";
    this.socket = socket;

    const ready = await new Promise<ReadyMessage>((resolve, reject) => {
      const fail = (message: string) => reject(new Error(message));

      socket.onopen = () => {
        this.setStatus("preparing_score");
        socket.send(
          JSON.stringify({
            type: "config",
            scoreHash,
            scoreXml,
            sampleRate: audioContext.sampleRate
          })
        );
      };

      socket.onerror = () => fail("Could not reach the alignment server.");
      socket.onclose = () => fail("The alignment server closed the connection.");

      socket.onmessage = (event) => {
        const message = JSON.parse(String(event.data));
        if (message.status === "need_score") {
          socket.send(JSON.stringify({ type: "config", scoreHash, scoreXml, sampleRate: audioContext.sampleRate }));
          return;
        }
        if (message.status === "ready") {
          resolve(message as ReadyMessage);
          return;
        }
        if (message.status === "error") {
          fail(message.message ?? "The alignment server reported an error.");
        }
      };
    });

    if (this.stopped) {
      this.teardown();
      return;
    }

    this.diagnostics.hopLength = ready.hopLength;
    this.diagnostics.totalQuarters = ready.totalQuarters;

    // From here on the socket is in its steady state: the handshake handlers above are replaced by
    // the position stream.
    socket.onmessage = (event) => this.handleServerMessage(String(event.data));
    socket.onerror = () => this.fail("The alignment connection failed.");
    socket.onclose = () => {
      if (this.stopped) {
        return;
      }
      if (this.diagnostics.status !== "completed" && this.diagnostics.status !== "error") {
        this.setStatus("completed");
        this.callbacks?.onCompleted?.();
      }
      this.stopAudio();
      this.socket = null;
      this.callbacks?.onClosed?.();
    };

    this.workletModuleUrl = URL.createObjectURL(new Blob([buildWorkletSource()], { type: "application/javascript" }));
    await audioContext.audioWorklet.addModule(this.workletModuleUrl);

    this.sourceNode = audioContext.createMediaStreamSource(this.clonedStream);
    this.workletNode = new AudioWorkletNode(audioContext, WORKLET_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      processorOptions: { hopLength: ready.hopLength }
    });

    // Silence is never sent -- not before the first note, and not during a pause. Silence carries
    // no pitch content, so it anchors the alignment to nothing, and the algorithm keeps advancing
    // through it at roughly the reference tempo regardless. Confirmed offline: six seconds of
    // silence before the first note put the tracker 8 quarter notes ahead, after which it could
    // only sprint forward (the follower never moves backwards), sweeping the whole piece in
    // seconds once real playing began. A pause mid-piece drifts the same way. So the gate is
    // level-driven for the whole session: while the microphone is below the calibrated noise
    // threshold (plus a short hold so bow changes and decay tails don't count), nothing is sent
    // and the tracker simply holds where it is; when sound returns, so does the audio. The server
    // side cooperates by starting alignment on the first chunk and disabling the library's
    // idle-queue timeouts, so a pause of any length is just a pause.
    const holdMs = options.gateHoldMs ?? 400;
    const chunkMs = (ready.hopLength / audioContext.sampleRate) * 1000;
    let lastLoudAtMs = -Infinity;
    let sentMs = 0;
    this.workletNode.port.onmessage = (event: MessageEvent<Float32Array>) => {
      if (socket.readyState !== WebSocket.OPEN) {
        return;
      }
      sentMs += chunkMs;
      if (rms(event.data) >= options.silenceRmsThreshold) {
        lastLoudAtMs = sentMs;
      }
      const open = sentMs - lastLoudAtMs <= holdMs;
      if (open !== this.diagnostics.gateOpen) {
        this.diagnostics.gateOpen = open;
        if (open && this.diagnostics.status === "waiting_for_sound") {
          this.setStatus("streaming");
        }
      }
      if (!open) {
        this.diagnostics.chunksDropped += 1;
        return;
      }
      socket.send(event.data.buffer);
      // Each posted chunk is its own buffer (the worklet slices), and WebSocket.send copies
      // rather than transferring, so retaining it here is safe.
      this.recordedChunks.push(event.data);
      this.diagnostics.chunksSent += 1;
    };

    this.sourceNode.connect(this.workletNode);
    // No destination connection: numberOfOutputs is 0, and routing mic audio to the speakers would
    // feed it straight back into the microphone.
    if (audioContext.state === "suspended") {
      await audioContext.resume();
    }

    this.setStatus("waiting_for_sound");
  }

  // Hard teardown: abandon the session. Nothing further is delivered -- no completion, no offline
  // alignment. For cancelling during preparation, a lost microphone, or a score re-render.
  stop(): void {
    this.stopped = true;
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type: "stop" }));
    }
    this.teardown();
    this.setStatus("idle");
  }

  // Graceful end of a take: stop capturing and sending audio, tell the server the take is over,
  // and keep the socket open for what comes back -- completion and the offline alignment. The
  // server closes the socket once it has sent them, which fires onClosed.
  finish(): void {
    this.stopAudio();
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type: "stop" }));
    }
  }

  // The take as sent, on the same timeline as the server's copy.
  getRecordedAudio(): Float32Array {
    const total = this.recordedChunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const audio = new Float32Array(total);
    let offset = 0;
    for (const chunk of this.recordedChunks) {
      audio.set(chunk, offset);
      offset += chunk.length;
    }
    return audio;
  }

  private handleServerMessage(raw: string): void {
    const message = JSON.parse(raw);

    if (message.type === "offlineAlignment" && Array.isArray(message.path)) {
      const path: AlignmentPoint[] = message.path.map(([perfTimeSeconds, quarter]: [number, number]) => ({
        perfTimeSeconds,
        quarter
      }));
      this.callbacks?.onOfflineAlignment?.(path);
      return;
    }

    if (typeof message.framesAccepted === "number") {
      this.diagnostics.framesAccepted = message.framesAccepted;
      this.diagnostics.framesRejected = message.framesRejected;
      return;
    }

    if (typeof message.quarter === "number") {
      this.diagnostics.positionsReceived += 1;
      this.diagnostics.lastQuarter = message.quarter;
      if (typeof message.serverTs === "number") {
        this.diagnostics.lastLatencyMs = Date.now() - message.serverTs;
      }
      this.callbacks?.onPosition(message.quarter);
      return;
    }

    if (message.status === "completed") {
      this.setStatus("completed");
      this.callbacks?.onCompleted?.();
      return;
    }

    if (message.status === "error") {
      // The socket stays open: the server still attempts the offline alignment after a live
      // failure (the recording is intact either way), then closes.
      this.diagnostics.error = message.message ?? "The alignment server reported an error.";
      this.stopAudio();
      this.setStatus("error");
      this.callbacks?.onError?.(this.diagnostics.error ?? "");
    }
  }

  private fail(message: string): void {
    this.diagnostics.error = message;
    this.setStatus("error");
    this.callbacks?.onError?.(message);
    this.teardown();
  }

  private setStatus(status: MatchmakerStreamStatus): void {
    this.diagnostics.status = status;
    this.callbacks?.onStatus?.(status);
  }

  private teardown(): void {
    this.stopAudio();
    if (this.socket && this.socket.readyState <= WebSocket.OPEN) {
      this.socket.close();
    }
    this.socket = null;
  }

  private stopAudio(): void {
    this.workletNode?.port.close();
    this.workletNode?.disconnect();
    this.workletNode = null;

    this.sourceNode?.disconnect();
    this.sourceNode = null;

    for (const track of this.clonedStream?.getTracks() ?? []) {
      track.stop();
    }
    this.clonedStream = null;

    void this.audioContext?.close().catch(() => undefined);
    this.audioContext = null;

    if (this.workletModuleUrl) {
      URL.revokeObjectURL(this.workletModuleUrl);
      this.workletModuleUrl = null;
    }
  }
}
