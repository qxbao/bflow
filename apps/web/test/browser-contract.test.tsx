import { render, cleanup } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { WEB_API_VERSION, WebSessionBootstrapRequestSchema } from "@bflow/contracts/web";
afterEach(cleanup);
it("renders with the real browser-safe contract subpath", () => {
  const view = render(<p data-api-version={WEB_API_VERSION}>Contract import smoke</p>);
  expect(view.getByText("Contract import smoke").getAttribute("data-api-version")).toBe("1");
  expect(WebSessionBootstrapRequestSchema.safeParse({ apiVersion: 2, secret: "x" }).success).toBe(false);
});

// Compile-time compatibility for recovering pre-run clarifications over the port.
import { expectTypeOf } from "vitest";
import type { UserInteractionClient, WebProjectSession } from "@bflow/contracts/web";
it("reserves the project session query on the interaction port", () => {
  expectTypeOf<UserInteractionClient["readProjectSession"]>().parameter(0).toEqualTypeOf<string>();
  expectTypeOf<UserInteractionClient["readProjectSession"]>().returns.resolves.extract<{ ok: true }>().toHaveProperty("value").toEqualTypeOf<WebProjectSession>();
});
