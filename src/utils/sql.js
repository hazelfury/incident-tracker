// Builds "(?, ?, ?)" for an IN clause with `count` bound parameters, e.g.
//   `WHERE id IN ${placeholders(ids.length)}`
function placeholders(count) {
  return `(${Array(count).fill("?").join(", ")})`;
}

module.exports = { placeholders };