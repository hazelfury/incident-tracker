const {
  STAFF_ROLES,
  MAX_REASON_LENGTH,
  canBeAssignee,
  canAssignIncidents,
  assigneeRoleMessage,
  assignerRoleMessage,
  validateAssignmentInput,
  normalizeReason,
} = require("../src/domain/assignmentRules");

describe("who may be assigned, and who may assign", () => {
  it("allows agents, managers and admins, and not requesters", () => {
    ["agent", "manager", "admin"].forEach((role) => {
      expect(canBeAssignee(role)).toBe(true);
      expect(canAssignIncidents(role)).toBe(true);
    });
    expect(canBeAssignee("requester")).toBe(false);
    expect(canAssignIncidents("requester")).toBe(false);
  });

  it("rejects unknown or missing roles", () => {
    [undefined, null, "", "Agent", "superuser"].forEach((role) => {
      expect(canBeAssignee(role)).toBe(false);
      expect(canAssignIncidents(role)).toBe(false);
    });
  });

  it("is frozen, so no code can widen it at runtime", () => {
    expect(Object.isFrozen(STAFF_ROLES)).toBe(true);
  });

  it("names the user, the field and the role in its messages", () => {
    expect(assigneeRoleMessage("u1", "requester")).toBe(
      "assignedTo must be an agent, manager or admin, but user u1 is a requester"
    );
    expect(assignerRoleMessage("u2", "requester")).toBe(
      "assignedBy must be an agent, manager or admin, but user u2 is a requester"
    );
  });
});

describe("validateAssignmentInput", () => {
  const ok = { assignedTo: "u1", assignedBy: "u2", reason: "handoff" };

  it("accepts a complete request", () => {
    expect(validateAssignmentInput(ok)).toBeNull();
  });

  it("accepts a request with only assignedTo (system assignment, no reason)", () => {
    expect(validateAssignmentInput({ assignedTo: "u1" })).toBeNull();
    expect(validateAssignmentInput({ assignedTo: "u1", assignedBy: null, reason: null })).toBeNull();
    expect(validateAssignmentInput({ assignedTo: "u1", assignedBy: "", reason: "" })).toBeNull();
  });

  test.each([undefined, null, ""])("requires assignedTo (%p)", (value) => {
    expect(validateAssignmentInput({ ...ok, assignedTo: value })).toBe("assignedTo is required");
  });

  test.each([[123], [true], [{ id: "u1" }], [["u1"]]])("rejects a non-string assignedTo (%p)", (value) => {
    expect(validateAssignmentInput({ ...ok, assignedTo: value })).toBe("assignedTo must be a user id (string)");
  });

  test.each([[123], [true], [{ id: "u2" }], [["u2"]]])("rejects a non-string assignedBy (%p)", (value) => {
    expect(validateAssignmentInput({ ...ok, assignedBy: value })).toBe("assignedBy must be a user id (string)");
  });

  test.each([[123], [true], [{ text: "x" }], [["x"]]])("rejects a non-string reason (%p)", (value) => {
    expect(validateAssignmentInput({ ...ok, reason: value })).toBe("reason must be text");
  });

  it("allows a reason of exactly the maximum length and rejects one longer", () => {
    expect(validateAssignmentInput({ ...ok, reason: "x".repeat(MAX_REASON_LENGTH) })).toBeNull();
    expect(validateAssignmentInput({ ...ok, reason: "x".repeat(MAX_REASON_LENGTH + 1) })).toBe(
      `reason must be ${MAX_REASON_LENGTH} characters or fewer`
    );
  });

  it("measures the reason after trimming", () => {
    const padded = `  ${"x".repeat(MAX_REASON_LENGTH)}  `;
    expect(validateAssignmentInput({ ...ok, reason: padded })).toBeNull();
  });
});

describe("normalizeReason", () => {
  it("trims text", () => {
    expect(normalizeReason("  needs VPN access  ")).toBe("needs VPN access");
  });

  it("returns null for blank or missing values", () => {
    ["", "   ", "\n\t", null, undefined].forEach((value) => expect(normalizeReason(value)).toBeNull());
  });

  it("returns null for non-text values", () => {
    [123, {}, [], true].forEach((value) => expect(normalizeReason(value)).toBeNull());
  });
});