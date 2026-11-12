import { describe, expect, it } from "vitest";
import { BACKEND_DOWN_LOCAL, BACKEND_DOWN_REMOTE_PAGE, backendDownText, isLocalHost } from "./shellWording";

describe("isLocalHost", () => {
  it("accepts this computer's names", () => {
    for (const h of ["localhost", "127.0.0.1", "[::1]", "::1", "medhop.localhost", "LOCALHOST"]) {
      expect(isLocalHost(h)).toBe(true);
    }
  });
  it("rejects other hosts", () => {
    for (const h of ["example.com", "medhop.netlify.app", "192.168.1.20", "localhost.example.com", ""]) {
      expect(isLocalHost(h)).toBe(false);
    }
  });
});

describe("backendDownText", () => {
  it("keeps the retry sentence when the page runs on this computer", () => {
    expect(backendDownText("localhost", "http://localhost:8010")).toBe(
      "Backend not reachable. Retrying every 2 seconds.",
    );
    expect(backendDownText("127.0.0.1", "http://127.0.0.1:8010")).toBe(BACKEND_DOWN_LOCAL);
  });
  it("explains the setup when a hosted page points at a local backend", () => {
    expect(backendDownText("medhop.netlify.app", "http://localhost:8010")).toBe(
      "This page is only the interface. It needs the MedHop backend running on this computer: start it with Start simulator.command, then open http://localhost:5180.",
    );
    expect(backendDownText("medhop.netlify.app", "http://127.0.0.1:8010")).toBe(BACKEND_DOWN_REMOTE_PAGE);
  });
  it("keeps the retry sentence when the API itself is remote or unparseable", () => {
    expect(backendDownText("medhop.netlify.app", "https://api.example.com")).toBe(BACKEND_DOWN_LOCAL);
    expect(backendDownText("medhop.netlify.app", "not a url")).toBe(BACKEND_DOWN_LOCAL);
  });
});
