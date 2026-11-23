# C4 architecture review for larger AMC changes

Trace the affected entry points and data flows before drawing. Use the current code, configuration and accepted ADRs to ground each boundary and relationship. Name the base commit and cite the files that establish the relationships. Mark proposed changes in the diagrams or show a separate proposed view when the delta would be hard to read.

1. **System context (C4 level 1).** Show AMC, its users, and the external systems involved in the change. Label each relationship with what crosses the system boundary.
2. **Containers (C4 level 2).** Show the relevant apps, processes and data stores inside AMC, including the caller, source of truth and direction of data flow. A C4 container represents a running application or data store.
3. **Components (C4 level 3).** Zoom into the affected container when the decision changes responsibilities or introduces a dependency inside it. Show existing entry points, the state owner and relevant collaborators. Repeat for another container only if it has a separate ownership decision to review.

Use readable Mermaid diagrams in the plan or extend existing architecture material when the diagrams will matter after this change. A single clearly annotated view per level can show both current and proposed relationships. [C4 diagram levels](https://c4model.com/diagrams)

Review the diagrams before implementation. Ask whether the current design can carry the change with the responsibilities it already has. Identify duplicate sources of truth, new dependency directions, missing ownership and the effects of retries or partial failures wherever they cross a boundary. Compare extending the current design with the smallest architectural change that resolves an observed problem. Record the decision, why it fits, any effect on existing callers, and how to verify it. Update the relevant spec or ADR when a durable contract changes. [AMC specs](../../../docs/specs) · [AMC decisions](../../../docs/adr)
