import { OpenSheetMusicDisplay } from "opensheetmusicdisplay";
import { applyAutomaticBeaming } from "./beamGrouping";
import { createScoreCursor, type ScoreCursor } from "./scoreCursor";

export type { CursorNoteInfo, ScoreCursor } from "./scoreCursor";

export interface RenderedScoreHandle {
  unmount(): void;
  cursor: ScoreCursor;
}

export interface ScoreRenderOptions {
  drawTitle?: boolean;
  drawComposer?: boolean;
  // Title/composer resolved by importMusicXmlToScore's credit-ranking heuristic. When set,
  // these override whatever OSMD would otherwise pick from the same (often unreliable, for
  // HOMR-sourced XML) <work-title>/<credit> data, so the rendered score and the app's
  // metadata card never disagree.
  titleOverride?: string;
  composerOverride?: string;
}

// Rewrites <work-title> and <identification><creator type="composer"> (creating either if
// absent) so OSMD's own title/composer-drawing logic picks up the already-resolved values
// instead of re-deriving its own from the same ambiguous page credits.
function applyMetadataOverrides(xml: string, title?: string, composer?: string): string {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.querySelector("parsererror")) {
    return xml;
  }

  if (title) {
    let work = doc.querySelector("work");
    if (!work) {
      work = doc.createElement("work");
      doc.documentElement.insertBefore(work, doc.documentElement.firstChild);
    }

    let workTitle = work.querySelector("work-title");
    if (!workTitle) {
      workTitle = doc.createElement("work-title");
      work.appendChild(workTitle);
    }
    workTitle.textContent = title;
  }

  if (composer) {
    let identification = doc.querySelector("identification");
    if (!identification) {
      identification = doc.createElement("identification");
      doc.documentElement.insertBefore(identification, doc.querySelector("part-list"));
    }

    let composerCreator = identification.querySelector('creator[type="composer"]');
    if (!composerCreator) {
      composerCreator = doc.createElement("creator");
      composerCreator.setAttribute("type", "composer");
      identification.appendChild(composerCreator);
    }
    composerCreator.textContent = composer;
  }

  return new XMLSerializer().serializeToString(doc);
}

// Removes <stem> from every <note> so setWantedStemDirectionByXml: false (set below) has
// nothing stale to ignore — OSMD then computes every stem direction automatically, which is
// beam-group-aware and enforces one consistent direction per beam once <beam> data (see
// applyAutomaticBeaming) correctly groups notes. Beam data itself is handled separately since
// OSMD's own automatic beaming isn't trustworthy enough to just fill gaps around — see
// beamGrouping.ts for why.
function stripStemHints(xml: string): string {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.querySelector("parsererror")) {
    return xml;
  }

  for (const element of Array.from(doc.querySelectorAll("note > stem"))) {
    element.remove();
  }

  return new XMLSerializer().serializeToString(doc);
}

// Whether the source XML already carries its own <beam> data. OSMD's `autoBeam` option only
// fills gaps for notes with none at all -- and that fallback has been directly confirmed to fail
// outright on certain patterns (repeating pitches; see beamGrouping.ts), not just to be a rough
// approximation. So whenever the source has no beam data of its own, we compute correct beams
// ourselves instead of trusting autoBeam -- regardless of where the XML came from. This used to
// only run for OMR/photo-sourced scores (gated on sourceType, since HOMR output typically has no
// beam data), which silently meant a directly-uploaded MusicXML file lacking its own beam data
// (common -- many exporters omit it) rendered with OSMD's broken autoBeam instead. A file that
// DOES already carry real beam data (e.g. from real notation software) is left untouched.
function hasBeamData(xml: string): boolean {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.querySelector("parsererror")) {
    // Can't tell -- let OSMD's own parse (and error handling) be the source of truth rather than
    // rewriting XML we couldn't even parse ourselves.
    return true;
  }
  return doc.querySelector("note > beam") !== null;
}

// Renders directly from the raw MusicXML text via OpenSheetMusicDisplay (OSMD) rather than
// through the app's internal ScoreDocument reduction. ScoreDocument drops rests, ties, slurs,
// articulations, and dynamics entirely (it only tracks pitched notes for score-following), so
// building notation from it can never be fidelity-complete regardless of which layout engine
// draws it. OSMD parses the source XML itself, so all of that survives.
export async function renderScore(
  xmlData: string,
  container: HTMLDivElement,
  options: ScoreRenderOptions = {}
): Promise<RenderedScoreHandle> {
  container.innerHTML = "";

  const osmd = new OpenSheetMusicDisplay(container, {
    autoResize: true,
    backend: "svg",
    autoBeam: true,
    setWantedStemDirectionByXml: false,
    drawTitle: options.drawTitle ?? true,
    drawComposer: options.drawComposer ?? true,
    onXMLRead: (xml: string) => {
      const withMetadata = applyMetadataOverrides(xml, options.titleOverride, options.composerOverride);
      if (hasBeamData(withMetadata)) {
        return withMetadata;
      }
      return applyAutomaticBeaming(stripStemHints(withMetadata));
    }
  });

  await osmd.load(xmlData);
  osmd.render();

  const cursor = createScoreCursor(osmd.cursor);
  cursor.hide();

  return {
    cursor,
    unmount() {
      osmd.clear();
      container.innerHTML = "";
    }
  };
}
