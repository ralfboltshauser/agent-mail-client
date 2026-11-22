import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const renderer = fileURLToPath(new URL('../../apps/desktop/src/renderer/src/', import.meta.url))
const profile = fileURLToPath(new URL('./profile.ts', import.meta.url))
const components: Record<string, string[]> = {
  'app.tsx': ['App', 'MailApp'],
  'components/app-sidebar.tsx': ['AppSidebar'],
  'components/thread-list.tsx': ['ThreadList'],
  'components/thread-view.tsx': ['ThreadView'],
  'components/composer.tsx': ['Composer'],
  'components/recipient-field.tsx': ['RecipientField'],
}

// The renderer project adds probes to the real return values before JSX compilation.
// This leaves hooks, props, React keys, and production source under test.
export function profileRenderer() {
  return {
    name: 'amc-renderer-profiler',
    enforce: 'pre' as const,
    transform(code: string, id: string) {
      if (!id.startsWith(renderer)) return
      const names = components[id.slice(renderer.length)]
      if (!names) return
      const source = ts.createSourceFile(id, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
      const edits: { offset: number; text: string }[] = []
      const wrap = (node: ts.Node, prefix: string, suffix: string) => {
        edits.push({ offset: node.getStart(source), text: prefix })
        edits.push({ offset: node.end, text: suffix })
      }

      for (const name of names) {
        const component = source.statements.find(
          (node): node is ts.FunctionDeclaration =>
            ts.isFunctionDeclaration(node) && node.name?.text === name,
        )
        if (!component?.body) throw new Error(`Update the renderer Profiler probe for ${name}`)

        function visit(node: ts.Node) {
          if (ts.isFunctionLike(node)) return
          if (ts.isReturnStatement(node) && node.expression) {
            wrap(node.expression, `__amcProfile('${name}', `, ')')
          }
          ts.forEachChild(node, visit)
        }
        visit(component.body)

        // Today the row bodies and compose footer are inline. Give each its own probe.
        function visitInline(node: ts.Node) {
          if (ts.isJsxElement(node)) {
            const { tagName, attributes } = node.openingElement
            if (name === 'Composer' && tagName.getText(source) === 'footer') {
              wrap(node, "{__amcProfile('footer', ", ')}')
            }
            if (name === 'ThreadList') {
              const role = attributes.properties.find(
                (prop) => ts.isJsxAttribute(prop) && prop.name.getText(source) === 'role',
              )
              if (
                role &&
                ts.isJsxAttribute(role) &&
                role.initializer?.getText(source) === '"option"'
              ) {
                const key = attributes.properties.find(
                  (prop) => ts.isJsxAttribute(prop) && prop.name.getText(source) === 'key',
                )
                const expression =
                  key &&
                  ts.isJsxAttribute(key) &&
                  key.initializer &&
                  ts.isJsxExpression(key.initializer)
                    ? key.initializer.expression?.getText(source)
                    : undefined
                if (!expression) throw new Error('The renderer row probe needs a thread key')
                wrap(node, `__amcProfile('row:' + ${expression}, `, `, ${expression})`)
              }
            }
          }
          ts.forEachChild(node, visitInline)
        }
        visitInline(component.body)
      }

      let instrumented = code
      for (const { offset, text } of edits.sort((a, b) => b.offset - a.offset)) {
        instrumented = instrumented.slice(0, offset) + text + instrumented.slice(offset)
      }
      return `import { profile as __amcProfile } from ${JSON.stringify(profile)}\n${instrumented}`
    },
  }
}
