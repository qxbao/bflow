// Plain node:http fixture app for real-app check tests. The mode comes from FIXTURE_MODE; PORT and HOST come from the driver.
import http from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const mode = process.env.FIXTURE_MODE ?? "good";
const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? "4173") + (mode === "wrongport" ? 1 : 0);

const shell = (body, head = "") => `<!doctype html><html><head><meta charset="utf-8">${head}</head><body>${body}</body></html>`;
const renderedApp = `<div id="app"></div><script src="/app.js"></script>`;
const pages = {
  good: shell(renderedApp),
  pageerror: shell(`<p>Hello</p><div id="app"></div><script>window.addEventListener("load", () => { null.x; });</script>`),
  consoleerror: shell(`<p>Hello</p><script>console.error("boom from page");</script>`),
  subresource500: shell(`<p>Hello</p><script src="/broken.js"></script>`),
  staticonly: shell(`<!-- <div data-testid="ready">Ready</div> --><template><div data-testid="ready">Ready</div></template>`),
  delayed: shell(`<div id="app"></div><script>setTimeout(() => { const d = document.createElement("div"); d.setAttribute("data-testid", "ready"); d.textContent = "Ready"; document.body.append(d); }, 1500);</script>`),
  wide: shell(`<p>Wide page</p><div style="width:1200px;height:40px;background:#ccc">wide</div>`, ""),
  wrongapi: shell(renderedApp),
  hang: shell(renderedApp),
  contractgap: shell(renderedApp),
  contractmissing: shell(renderedApp),
  exit: null,
  wrongport: shell(renderedApp),
};

function send(response, status, type, body) {
  response.writeHead(status, { "content-type": type });
  response.end(body);
}

if (mode === "exit") {
  console.error("fixture fatal startup error");
  process.exit(3);
}

const server = http.createServer((request, response) => {
  const path = new URL(request.url, "http://localhost").pathname;
  if (path === "/health") return send(response, 200, "text/plain", "ok");
  if (path === "/") return send(response, 200, "text/html; charset=utf-8", pages[mode] ?? pages.good);
  if (path === "/app.js") {
    return send(response, 200, "application/javascript", `fetch("/api/items").then(r => r.json()).then(items => {
      const title = document.createElement("h1");
      title.setAttribute("data-testid", "title");
      title.textContent = "Welcome " + items[0].name;
      document.getElementById("app").append(title);
    });`);
  }
  if (path === "/broken.js") return send(response, 500, "text/plain", "");
  if (path === "/api/items") {
    if (mode === "hang") return;
    // FIXTURE_ITEMS_FILE names a committed JSON file in the app's working directory (the checkout), so each commit can change the data.
    if (process.env.FIXTURE_ITEMS_FILE) return send(response, 200, "application/json; charset=utf-8", readFileSync(join(process.cwd(), process.env.FIXTURE_ITEMS_FILE), "utf8"));
    const name = mode === "wrongapi" ? "pear" : "apple";
    return send(response, 200, "application/json; charset=utf-8", JSON.stringify([{ name }]));
  }
  if (path === "/api/hang") return;
  if (path === "/openapi.json") {
    if (mode === "contractmissing") return send(response, 404, "text/plain", "not found");
    const paths = mode === "contractgap" ? { "/api/other": { get: {} } } : { "/api/items": { get: {} } };
    return send(response, 200, "application/json", JSON.stringify({ openapi: "3.0.0", paths }));
  }
  return send(response, 404, "text/plain", "not found");
});

server.listen(port, host);
