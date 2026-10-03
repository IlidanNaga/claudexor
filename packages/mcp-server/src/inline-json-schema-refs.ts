// Inline generated refs once at load; the SDK requires self-contained schemas.
export function inlineJsonSchemaRefs(schema: Record<string, unknown>): Record<string, unknown> {
  const resolvePointer = (pointer: string): unknown => {
    let node: unknown = schema;
    for (const rawSegment of pointer.split("/").slice(1)) {
      const segment = rawSegment.replaceAll("~1", "/").replaceAll("~0", "~");
      if (Array.isArray(node)) node = node[Number(segment)];
      else if (node && typeof node === "object") node = (node as Record<string, unknown>)[segment];
      else return undefined;
    }
    return node;
  };
  const resolve = (node: unknown, stack: readonly string[]): unknown => {
    if (Array.isArray(node)) return node.map((child) => resolve(child, stack));
    if (!node || typeof node !== "object") return node;
    const obj = node as Record<string, unknown>;
    const ref = obj["$ref"];
    if (typeof ref === "string" && ref.startsWith("#/")) {
      // Generated schemas are trees; fail loudly if a refactor introduces recursion.
      if (stack.includes(ref))
        throw new Error(
          `cyclic $ref '${ref}' in a generated tool schema — flatten the schema or drop its outputSchema`,
        );
      const target = resolvePointer(ref);
      if (target === undefined)
        throw new Error(`unresolved $ref '${ref}' in a generated tool schema`);
      return resolve(target, [...stack, ref]);
    }
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (key === "definitions") continue;
      out[key] = resolve(value, stack);
    }
    return out;
  };
  return resolve(schema, []) as Record<string, unknown>;
}
