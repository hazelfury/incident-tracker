const {
  ENTITY_TYPES,
  AUDIT_ACTIONS,
  AUDIT_ACTION_VALUES,
  FIELDS,
  isValidAuditAction,
  diffFields,
  compactMetadata,
} = require("../src/domain/auditPolicy");

describe("audit actions", () => {
  it("lists every action once, as '<entity>.<verb>' names", () => {
    expect(new Set(AUDIT_ACTION_VALUES).size).toBe(AUDIT_ACTION_VALUES.length);
    AUDIT_ACTION_VALUES.forEach((a) => expect(a).toMatch(/^[a-z]+\.[a-z_]+$/));
    expect(AUDIT_ACTION_VALUES).toEqual(Object.values(AUDIT_ACTIONS));
  });

  it("is frozen, so no code can add actions at runtime", () => {
    expect(Object.isFrozen(AUDIT_ACTIONS)).toBe(true);
    expect(Object.isFrozen(AUDIT_ACTION_VALUES)).toBe(true);
    expect(Object.isFrozen(ENTITY_TYPES)).toBe(true);
    expect(Object.isFrozen(FIELDS)).toBe(true);
    Object.values(FIELDS).forEach((list) => expect(Object.isFrozen(list)).toBe(true));
  });

  it("accepts known actions and rejects everything else", () => {
    AUDIT_ACTION_VALUES.forEach((a) => expect(isValidAuditAction(a)).toBe(true));
    ["", "incident", "INCIDENT.CREATED", "incident.deleted", null, undefined, 1, {}].forEach((v) =>
      expect(isValidAuditAction(v)).toBe(false)
    );
  });
});

describe("diffFields", () => {
  it("lists only the fields that changed, as from/to pairs", () => {
    const before = { status: "new", assignee_id: null, title: "x" };
    const after = { status: "assigned", assignee_id: "u1", title: "x" };
    expect(diffFields(before, after, ["status", "assignee_id", "title"])).toEqual({
      status: { from: "new", to: "assigned" },
      assignee_id: { from: null, to: "u1" },
    });
  });

  it("returns {} when nothing changed", () => {
    expect(diffFields({ status: "new" }, { status: "new" }, ["status"])).toEqual({});
  });

  it("ignores fields that are not listed", () => {
    expect(diffFields({ a: 1, b: 1 }, { a: 2, b: 2 }, ["a"])).toEqual({ a: { from: 1, to: 2 } });
  });

  it("treats a missing object or field as null, so a creation lists every non-null field", () => {
    expect(diffFields(null, { status: "new", team_id: null, title: "t" }, ["status", "team_id", "title"])).toEqual({
      status: { from: null, to: "new" },
      title: { from: null, to: "t" },
    });
    expect(diffFields({}, { status: "x" }, ["status"])).toEqual({ status: { from: null, to: "x" } });
    expect(diffFields({ status: "x" }, null, ["status"])).toEqual({ status: { from: "x", to: null } });
  });

  it("treats undefined and null as the same 'no value'", () => {
    expect(diffFields({ a: undefined }, { a: null }, ["a"])).toEqual({});
  });

  it("records clearing a value (reopen clears resolved_at)", () => {
    expect(diffFields({ resolved_at: "t" }, { resolved_at: null }, FIELDS.status)).toEqual({
      resolved_at: { from: "t", to: null },
    });
  });
});

describe("compactMetadata", () => {
  it("drops null, undefined and empty values", () => {
    expect(compactMetadata({ note: "", reason: null, other: undefined, kept: "yes" })).toEqual({ kept: "yes" });
  });

  it("keeps falsy-but-meaningful values", () => {
    expect(compactMetadata({ count: 0, flag: false })).toEqual({ count: 0, flag: false });
  });

  it("merges sources, later ones winning", () => {
    expect(compactMetadata({ a: 1, b: 1 }, { b: 2 })).toEqual({ a: 1, b: 2 });
  });

  it("returns null when nothing is left, and copes with missing sources", () => {
    expect(compactMetadata({ note: "" })).toBeNull();
    expect(compactMetadata(null, undefined)).toBeNull();
    expect(compactMetadata()).toBeNull();
  });
});