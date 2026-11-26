import { describe, expect, it } from "vitest";

import {
  ALL_AUTH_SCOPES,
  type AuthContext,
  hasAuthScope,
  parseRunActor,
  toRunActor,
} from "../../src/index.js";

const context: AuthContext = {
  subject: {
    subjectId: "owner",
    displayName: "Owner",
    actorType: "human",
    scopes: ["runs:execute"],
    claims: { email: "owner@example.test" },
  },
  credentialSource: "bearer",
  credentialId: "token:abc",
  audit: {},
};

describe("identity contracts", () => {
  it("projects an auth context to a redaction-safe run actor", () => {
    expect(toRunActor(context)).toEqual({
      subjectId: "owner",
      actorType: "human",
      credentialSource: "bearer",
      displayName: "Owner",
      credentialId: "token:abc",
    });
    expect(toRunActor(context)).not.toHaveProperty("claims");
  });

  it("checks scopes", () => {
    expect(hasAuthScope(context, "runs:execute")).toBe(true);
    expect(hasAuthScope(context, "tokens:manage")).toBe(false);
    expect(hasAuthScope(undefined, "runs:execute")).toBe(false);
    expect(ALL_AUTH_SCOPES).toEqual(["runs:execute", "runs:read", "tokens:manage"]);
  });

  it("parses untrusted run actors", () => {
    expect(
      parseRunActor({
        subjectId: "owner",
        actorType: "human",
        credentialSource: "cookie",
        token: "should be dropped",
      }),
    ).toEqual({ subjectId: "owner", actorType: "human", credentialSource: "cookie" });
    expect(parseRunActor({ subjectId: "", actorType: "human", credentialSource: "cookie" })).toBe(
      undefined,
    );
    expect(parseRunActor({ subjectId: "x", actorType: "robot", credentialSource: "cookie" })).toBe(
      undefined,
    );
    expect(parseRunActor(null)).toBeUndefined();
  });
});
