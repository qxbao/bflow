// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ProjectConfiguration } from "../src/features/project-configuration";
import { ApiError, ConfigurationError, type ApiClient } from "../src/api/client";

const DEEPWIKI_TITLE = "Tra cứu tài liệu DeepWiki";
const REVISION = "a".repeat(64);
const roles = [{ role: "conversation", cli: "claude", required: true }];

function configuration(environment: Record<string, unknown> = {}) {
  return { apiVersion: 1, projectId: "p", revision: REVISION, yaml: "projectName: Sample\nenvironment: {}\n",
    values: { projectName: "Sample", environment: { roles, deepwiki: { enabled: true, required: false }, ...environment } } };
}

function fakeApi(overrides: { configuration?: () => Promise<unknown>; saveConfiguration?: (id: string, input: any) => Promise<unknown> } = {}) {
  const loaded = configuration();
  const api = {
    configuration: vi.fn(overrides.configuration ?? (async () => loaded)),
    saveConfiguration: vi.fn(overrides.saveConfiguration ?? (async (_id: string, input: any) => ({ ...loaded, revision: "b".repeat(64), values: input.values })))
  };
  return { api, client: api as unknown as ApiClient };
}

const mount = (client: ApiClient) => render(React.createElement(ProjectConfiguration, { api: client, id: "p", revision: 0 }));
const deepwikiGroup = async () => within(await screen.findByRole("group", { name: DEEPWIKI_TITLE }));

beforeEach(() => { vi.stubGlobal("React", React); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("DeepWiki integration", () => {
  it("settings form toggles enabled and required in the DOM", async () => {
    const { api, client } = fakeApi();
    mount(client);
    await waitFor(() => expect(screen.queryByRole("group", { name: DEEPWIKI_TITLE })).not.toBeNull());
    const group = await deepwikiGroup();
    const enabled = group.getByRole("checkbox", { name: /^enabled/ }) as HTMLInputElement;
    const required = group.getByRole("checkbox", { name: /^required/ }) as HTMLInputElement;
    expect([enabled.checked, required.checked]).toEqual([true, false]);
    // DeepWiki needs no key and keeps no cache setting, so the form offers nothing beyond the two switches.
    expect(group.getAllByRole("checkbox")).toHaveLength(2);
    expect(screen.queryByText(/context7/i, { selector: "summary, legend" })).toBeNull();
    expect(screen.queryByLabelText(/api.?key|cache|ttl/i)).toBeNull();

    fireEvent.click(enabled);
    fireEvent.click(required);
    expect([enabled.checked, required.checked]).toEqual([false, true]);
    fireEvent.click(screen.getByRole("button", { name: "Lưu cấu hình" }));

    await waitFor(() => expect(api.saveConfiguration).toHaveBeenCalledTimes(1));
    expect(api.saveConfiguration).toHaveBeenCalledWith("p", expect.objectContaining({ apiVersion: 1, expectedRevision: REVISION,
      values: expect.objectContaining({ environment: expect.objectContaining({ deepwiki: { enabled: false, required: true } }) }) }));
    expect(await screen.findByText(/Đã lưu cấu hình/)).toBeTruthy();
    const saved = await deepwikiGroup();
    expect((saved.getByRole("checkbox", { name: /^enabled/ }) as HTMLInputElement).checked).toBe(false);
    expect((saved.getByRole("checkbox", { name: /^required/ }) as HTMLInputElement).checked).toBe(true);
  });

  it("settings shows input and network errors", async () => {
    const failures: unknown[] = [new ConfigurationError("environment.deepwiki.required phải là true hoặc false."), new ApiError("unavailable"), new Error("fetch failed")];
    const { api, client } = fakeApi({ saveConfiguration: async () => { throw failures.shift(); } });
    mount(client);
    await waitFor(() => expect(screen.queryByRole("group", { name: DEEPWIKI_TITLE })).not.toBeNull());
    const group = await deepwikiGroup();
    fireEvent.click(group.getByRole("checkbox", { name: /^required/ }));
    const save = () => fireEvent.click(screen.getByRole("button", { name: "Lưu cấu hình" }));

    save();
    expect((await screen.findByRole("alert")).textContent).toBe("environment.deepwiki.required phải là true hoặc false.");
    save();
    await waitFor(() => expect(api.saveConfiguration).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/Chưa kết nối được dịch vụ/));
    save();
    await waitFor(() => expect(api.saveConfiguration).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/Chưa kết nối được dịch vụ/));
    // The unsaved edit survives a failed save instead of being silently dropped.
    expect(((await deepwikiGroup()).getByRole("checkbox", { name: /^required/ }) as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByText(/Đã lưu cấu hình/)).toBeNull();
  });

  it("web suite regression runs under jsdom", async () => {
    expect(navigator.userAgent).toContain("jsdom");
    expect(typeof document.createElement).toBe("function");
    // A configuration that still carries a stale context7 block is shown by its raw key; only DeepWiki has a titled section.
    const { api, client } = fakeApi({ configuration: async () => configuration({ context7: { enabled: true, required: false } }) });
    mount(client);
    await waitFor(() => expect(screen.queryByRole("group", { name: DEEPWIKI_TITLE })).not.toBeNull());
    expect(screen.queryByText("Tra cứu tài liệu Context7")).toBeNull();
    expect(api.configuration).toHaveBeenCalledWith("p");
    // A failed read offers a retry that renders the form.
    cleanup();
    let attempts = 0;
    const flaky = fakeApi({ configuration: async () => { if (attempts++ === 0) throw new Error("network down"); return configuration(); } });
    mount(flaky.client);
    expect((await screen.findByRole("alert")).textContent).toMatch(/Chưa đọc được cấu hình/);
    fireEvent.click(screen.getByRole("button", { name: "Đọc lại cấu hình" }));
    await waitFor(() => expect(screen.queryByRole("group", { name: DEEPWIKI_TITLE })).not.toBeNull());
  });
});
