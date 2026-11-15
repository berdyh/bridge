import { describe, expect, it } from "vitest";

import { formatEnrollFragment, parseEnrollFragment } from "./index.js";

const runnerId = "3f2b8c1e-7a44-4f0e-9b1d-0c5e2a6d9f10";

describe("enroll link", () => {
  it("formats with a leading # and round-trips with or without it", () => {
    const hash = formatEnrollFragment({ code: "bcdf-ghjk", runnerId });
    expect(hash).toBe(`#code=BCDFGHJK&runner=${runnerId}`);
    expect(parseEnrollFragment(hash)).toEqual({ code: "BCDFGHJK", runnerId });
    expect(parseEnrollFragment(hash.slice(1))).toEqual({ code: "BCDFGHJK", runnerId });
    expect(parseEnrollFragment(`#runner=${runnerId}&code=BCDF-GHJK`)).toEqual({ code: "BCDFGHJK", runnerId });
  });

  it("refuses to format a bad code or runner id", () => {
    expect(() => formatEnrollFragment({ code: "AEIOU123", runnerId })).toThrow();
    expect(() => formatEnrollFragment({ code: "BCDFGHJK", runnerId: "a&b" })).toThrow();
    expect(() => formatEnrollFragment({ code: "BCDFGHJK", runnerId: "" })).toThrow();
  });

  it.each([
    ["an empty fragment", ""],
    ["only a #", "#"],
    ["a missing runner", "#code=BCDFGHJK"],
    ["a missing code", `#runner=${runnerId}`],
    ["an unknown key", `#code=BCDFGHJK&runner=${runnerId}&x=1`],
    ["a duplicate code", `#code=BCDFGHJK&code=BCDFGHJK&runner=${runnerId}`],
    ["a duplicate runner", `#code=BCDFGHJK&runner=${runnerId}&runner=${runnerId}`],
    ["an invalid code", `#code=AEIOU123&runner=${runnerId}`],
    ["a short code", `#code=BCDF&runner=${runnerId}`],
    ["a percent-encoded code", `#code=%42CDFGHJK&runner=${runnerId}`],
    ["a plus in the code", `#code=BCDF+GHJK&runner=${runnerId}`],
    ["a percent-encoded runner", `#code=BCDFGHJK&runner=a%2Fb`],
    ["a slash in the runner", `#code=BCDFGHJK&runner=a/b`],
    ["an empty runner", `#code=BCDFGHJK&runner=`],
    ["a part without =", `#code=BCDFGHJK&runner=${runnerId}&x`],
    ["a trailing &", `#code=BCDFGHJK&runner=${runnerId}&`],
    ["an over-long runner", `#code=BCDFGHJK&runner=${"a".repeat(129)}`],
  ])("rejects %s", (_name, hash) => {
    expect(parseEnrollFragment(hash)).toBeUndefined();
  });
});
