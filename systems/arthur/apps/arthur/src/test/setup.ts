import { cleanup, configure } from "@testing-library/react";
import { afterEach } from "vitest";

// The Settings screens grew (one section per feature), and a role query over a large jsdom tree is slow when the whole suite is running
// in parallel. This only lets a legitimate wait last longer before it is reported; it never relaxes an assertion.
configure({ asyncUtilTimeout: 5000 });

afterEach(() => {
  cleanup();
});
