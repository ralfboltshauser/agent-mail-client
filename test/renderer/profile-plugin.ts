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
  'features/composer/footer.tsx': ['ComposerFooter'],
  'features/composer/header-fields.tsx': ['SubjectField'],
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
        const memoized = source.statements
          .filter(ts.isVariableStatement)
          .flatMap((statement) => [...statement.declarationList.declarations])
          .find((declaration) => declaration.name.getText(source) === name)?.initializer
        const memoBody =
          memoized &&
          ts.isCallExpression(memoized) &&
          memoized.expression.getText(source) === 'memo'
            ? memoized.arguments[0]
            : undefined
        const body =
          component?.body ??
          (memoBody && ts.isFunctionExpression(memoBody) ? memoBody.body : undefined)
        if (!body) throw new Error(`Update the renderer Profiler probe for ${name}`)
        const region = name === 'ComposerFooter' ? 'footer' : name

        function visit(node: ts.Node) {
          if (ts.isFunctionLike(node)) return
          if (ts.isReturnStatement(node) && node.expression) {
            wrap(node.expression, `__amcProfile('${region}', `, ')')
          }
          ts.forEachChild(node, visit)
        }
        visit(body)

        // Row bodies are inline. Give each its own probe.
        function visitInline(node: ts.Node) {
          if (ts.isJsxElement(node)) {
            const { attributes } = node.openingElement
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
        visitInline(body)
      }

      let instrumented = code
      for (const { offset, text } of edits.sort((a, b) => b.offset - a.offset)) {
        instrumented = instrumented.slice(0, offset) + text + instrumented.slice(offset)
      }
      return `import { profile as __amcProfile } from ${JSON.stringify(profile)}\n${instrumented}`
    },
  }
}
