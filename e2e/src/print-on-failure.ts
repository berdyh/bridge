import { beforeEach } from "vitest";

import { startedOutput } from "./machine.js";

// A failed test shows only the client's error (for example "agent claude failed to start"); the cause is in the
// runner's log. Print every bridge process's stderr so a failure on CI can be diagnosed without a rerun.
beforeEach(({ onTestFailed }) => {
  onTestFailed(() => {
    const output = startedOutput();
    if (output !== "") console.error(output);
  });
});
