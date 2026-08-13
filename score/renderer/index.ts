import { OpenSheetMusicDisplay } from "opensheetmusicdisplay";
import { applyAutomaticBeaming } from "./beamGrouping";

export interface RenderedScoreHandle {
  unmount(): void;
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
  // Strips HOMR's <stem> hints and replaces any <beam> data with our own beat-aware
  // computation (see beamGrouping.ts) — OSMD's own automatic beaming isn't reliable enough
  // on real HOMR output (confirmed: it fails outright on repeating pitch patterns). Only
  // meaningful for OMR-sourced scores — see renderScore.
  stripUnreliableBeaming?: boolean;
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

  const hasOverride = Boolean(options.titleOverride || options.composerOverride || options.stripUnreliableBeaming);

  const osmd = new OpenSheetMusicDisplay(container, {
    autoResize: true,
    backend: "svg",
    autoBeam: true,
    setWantedStemDirectionByXml: false,
    drawTitle: options.drawTitle ?? true,
    drawComposer: options.drawComposer ?? true,
    onXMLRead: hasOverride
      ? (xml: string) => {
          const withMetadata = applyMetadataOverrides(xml, options.titleOverride, options.composerOverride);
          if (!options.stripUnreliableBeaming) {
            return withMetadata;
          }
          return applyAutomaticBeaming(stripStemHints(withMetadata));
        }
      : undefined
  });

  await osmd.load(xmlData);
  osmd.render();

  return {
    unmount() {
      osmd.clear();
      container.innerHTML = "";
    }
  };
}
