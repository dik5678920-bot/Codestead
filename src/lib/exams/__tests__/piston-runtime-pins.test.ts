import { describe, expect, it } from "vitest";

import handoff from "../../../../infra/piston/pr4b-runtime-handoff.json";
import publicationPins from "../../../../infra/piston/pr4b-publication-pins.json";
import runtimePins from "../piston-runtime-pins.json";

describe("shipped Piston exam runtime pins", () => {
  it("matches every runtime handoff field consumed by the app and workers", () => {
    expect(runtimePins.handoff).toEqual({
      schemaVersion: handoff.schemaVersion,
      imageReference: handoff.imageReference,
      runtimeLabels: handoff.runtimeLabels,
      validation: {
        passed: handoff.validation.passed,
        liveTests: handoff.validation.liveTests,
      },
    });
  });

  it("matches the reviewed publication revision and every legacy pin", () => {
    expect(runtimePins.publicationPins).toEqual({
      schemaVersion: publicationPins.schemaVersion,
      revision: publicationPins.revision,
      imageReference: publicationPins.imageReference,
      legacyPins: publicationPins.legacyPins,
    });
  });
});
