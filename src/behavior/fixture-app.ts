import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/** Which defenses a fixture application has; every one on is the correct application. */
export interface Defenses {
  readonly ownerCheck: boolean;
  readonly serveOwners: boolean;
  readonly singleUse: boolean;
  readonly atomicRedeem: boolean;
  readonly expiry: boolean;
  readonly idempotent: boolean;
  readonly atomicPayment: boolean;
}

export const correct: Defenses = {
  ownerCheck: true,
  serveOwners: true,
  singleUse: true,
  atomicRedeem: true,
  expiry: true,
  idempotent: true,
  atomicPayment: true,
};

const tick = () => new Promise((settle) => setTimeout(settle, 15));

/**
 * A small API with an owned resource, an expiring single-use token and a payment, each with the
 * defenses a test turns off to make a known-incorrect application. Synthetic users and tokens.
 */
export async function fixtureApp(
  defenses: Defenses,
  tokenLifeMs = 400,
): Promise<{ readonly base: string; readonly server: Server }> {
  const invoices = new Map([["1", { owner: "ada", number: "INV-0001-ADA" }]]);
  const tokens = new Map<string, { used: boolean; issued: number }>();
  const paid = new Set<string>();
  let balance = 100;
  let serial = 0;
  const server = createServer(async (request, response) => {
    const send = (status: number, body: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    const user = request.headers["x-user"];
    const [, area, id] = (request.url ?? "/").split("/");
    if (area === "invoices" && request.method === "GET") {
      if (typeof user !== "string") return send(401, { error: "sign in" });
      const invoice = invoices.get(id ?? "");
      if (invoice === undefined || !defenses.serveOwners) return send(404, { error: "not found" });
      if (defenses.ownerCheck && invoice.owner !== user) return send(404, { error: "not found" });
      return send(200, invoice);
    }
    if (area === "tokens" && request.method === "POST") {
      serial += 1;
      const token = `synthetic-${serial}`;
      tokens.set(token, { used: false, issued: Date.now() });
      return send(201, { token });
    }
    if (area === "redeem" && request.method === "POST") {
      const token = tokens.get(id ?? "");
      if (token === undefined) return send(404, { error: "unknown token" });
      if (defenses.expiry && Date.now() - token.issued > tokenLifeMs)
        return send(410, { error: "expired" });
      if (defenses.singleUse && token.used) return send(409, { error: "already used" });
      // Without atomicity the check and the mark are apart, as a read-then-write in a store is.
      if (!defenses.atomicRedeem) await tick();
      token.used = true;
      return send(200, { redeemed: true });
    }
    if (area === "payments" && request.method === "POST") {
      const key = String(request.headers["idempotency-key"]);
      if (defenses.idempotent && paid.has(key)) return send(200, { balance, replayed: true });
      if (!defenses.atomicPayment) await tick();
      paid.add(key);
      balance -= 10;
      return send(201, { balance });
    }
    if (area === "balance") return send(200, { balance });
    return send(200, { ok: true });
  });
  await new Promise<void>((settle) => server.listen(0, "127.0.0.1", settle));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server };
}
