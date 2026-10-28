// Real HTTP app fixture for the QA-only workflow tests. It runs as a separate process on 127.0.0.1 and contains one
// deliberate product bug: the bulk discount (10% from 10 items) is applied only above 10 items.
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const build = process.env.QA_APP_BUILD_ID;
const products = { p1: { id: "p1", name: "Widget", price: 100 } };
const carts = new Map();
const stats = { requests: [], deletes: 0 };

function send(response, status, body, headers = {}) {
  const text = body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body);
  response.writeHead(status, { "content-type": typeof body === "string" ? "text/plain" : "application/json", ...headers });
  response.end(text);
}
async function json(request) {
  let text = "";
  for await (const chunk of request) text += chunk;
  return text ? JSON.parse(text) : {};
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, "http://fixture");
  if (url.pathname !== "/__stats") stats.requests.push(`${request.method} ${url.pathname}`);
  try {
    if (url.pathname === "/health") return send(response, 200, "ok");
    if (url.pathname === "/__stats") return send(response, 200, { ...stats, carts: [...carts.values()] });
    if (url.pathname === "/__build") return build ? send(response, 200, { build }) : send(response, 404, { error: "unknown" });
    if (url.pathname === "/go-away") return send(response, 302, "", { location: "http://example.invalid/collect" });
    if (url.pathname === "/moved") return send(response, 302, "", { location: "/api/products/p1" });
    const product = /^\/api\/products\/([a-z0-9]+)$/.exec(url.pathname);
    if (product && request.method === "GET") return products[product[1]] ? send(response, 200, products[product[1]]) : send(response, 404, { error: "not_found" });
    if (url.pathname === "/api/quote" && request.method === "GET") {
      const item = products[url.searchParams.get("productId")];
      const qty = Number(url.searchParams.get("qty"));
      if (!item || !Number.isInteger(qty) || qty < 1) return send(response, 400, { error: "invalid" });
      // BUG: the specification grants 10% from 10 items; the product applies it only above 10.
      const total = item.price * qty * (qty > 10 ? 0.9 : 1);
      return send(response, 200, { productId: item.id, qty, total });
    }
    if ((url.pathname === "/api/carts" || url.pathname === "/api/slow-carts") && request.method === "POST") {
      const body = await json(request);
      const cart = { id: randomUUID(), label: String(body.label ?? ""), token: "secret-session-token" };
      carts.set(cart.id, cart);
      if (url.pathname === "/api/slow-carts") await new Promise(resolve => setTimeout(resolve, 3_000));
      return send(response, 201, cart, { "set-cookie": "session=abc123; HttpOnly" });
    }
    if (url.pathname === "/api/carts" && request.method === "GET") {
      const label = url.searchParams.get("label");
      return send(response, 200, [...carts.values()].filter(item => label === null || item.label === label));
    }
    const cart = /^\/api\/carts\/([a-f0-9-]+)$/.exec(url.pathname);
    if (cart && request.method === "GET") return carts.has(cart[1]) ? send(response, 200, carts.get(cart[1])) : send(response, 404, { error: "not_found" });
    if (cart && request.method === "DELETE") {
      const found = carts.get(cart[1]);
      if (!found) return send(response, 404, { error: "not_found" });
      if (found.label.includes("locked")) return send(response, 500, { error: "cart is locked" });
      carts.delete(cart[1]);
      stats.deletes++;
      return send(response, 204);
    }
    return send(response, 404, { error: "not_found" });
  } catch (error) {
    return send(response, 500, { error: String(error) });
  }
});

server.listen(0, "127.0.0.1", () => {
  process.stdout.write(`LISTENING ${server.address().port}\n`);
});
process.on("SIGTERM", () => server.close(() => process.exit(0)));
