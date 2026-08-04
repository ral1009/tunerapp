declare module "wav-decoder" {
  export interface DecodedAudioData {
    sampleRate: number;
    channelData: Float32Array[];
  }

  const WavDecoder: {
    decode(buffer: ArrayBuffer | Uint8Array | Buffer): Promise<DecodedAudioData>;
  };

  export default WavDecoder;
}