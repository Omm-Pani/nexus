/** Recover declarative and pre-existing closed roots through Chromium's DOM domain. */
export async function recoverShadowRoots(
  send: (method: string, params?: Record<string, unknown>) => Promise<unknown>,
): Promise<void> {
  type Node = {
    backendNodeId?: number;
    shadowRootType?: string;
    children?: Node[];
    shadowRoots?: Node[];
    contentDocument?: Node;
    templateContent?: Node;
  };
  const { root } = (await send("DOM.getDocument", {
    depth: -1,
    pierce: true,
  })) as { root?: Node };
  if (root === undefined) return;
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    stack.push(...(node.children ?? []), ...(node.shadowRoots ?? []));
    if (node.contentDocument !== undefined) stack.push(node.contentDocument);
    if (node.templateContent !== undefined) stack.push(node.templateContent);
    // Browser-internal control implementation is not part of the application's DOM.
    if (node.shadowRootType !== "closed" && node.shadowRootType !== "open")
      continue;
    const resolved = (await send("DOM.resolveNode", {
      backendNodeId: node.backendNodeId,
      objectGroup: "nexus-shadow",
    })) as { object?: { objectId?: string } };
    if (resolved.object?.objectId === undefined) continue;
    try {
      await send("Runtime.callFunctionOn", {
        objectId: resolved.object.objectId,
        functionDeclaration:
          "function() { this.host.ownerDocument.defaultView.__nexusDom?.registerShadowRoot(this); this.host.ownerDocument.defaultView.__nexus?.registerShadowRoot(this); }",
        returnByValue: true,
      });
    } finally {
      await send("Runtime.releaseObject", {
        objectId: resolved.object.objectId,
      });
    }
  }
}
