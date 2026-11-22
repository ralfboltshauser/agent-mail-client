import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const renderer = fileURLToPath(new URL('../../apps/desktop/src/renderer/src/', import.meta.url))
const profile = fileURLToPath(new URL('./profile.ts', import.meta.url))
const components = new Set([
  'App',
  'MailWorkspace',
  'AppSidebar',
  'ThreadList',
  'ThreadView',
  'Composer',
  'RecipientField',
])

function getThreadRow(declaration: ts.VariableDeclaration) {
  const { name, initializer } = declaration
  if (!ts.isIdentifier(name) || name.text !== 'ThreadRow') return
  if (
    initializer &&
    ts.isCallExpression(initializer) &&
    ts.isIdentifier(initializer.expression) &&
    initializer.expression.text === 'memo'
  ) {
    const render = initializer.arguments[0]
    if (render && ts.isFunctionExpression(render)) return render
  }
  throw new Error('Update the renderer Profiler probe for ThreadRow')
}

// The renderer project adds probes to the real return values before JSX compilation.
export function profileRenderer() {
  return {
    name: 'amc-renderer-profiler',
    enforce: 'pre' as const,
    transform(code: string, id: string) {
      if (!id.startsWith(renderer) || !id.endsWith('.tsx')) return
      const source = ts.createSourceFile(id, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
      const edits: { offset: number; text: string }[] = []
      const wrap = (node: ts.Node, prefix: string, suffix: string) => {
        edits.push({ offset: node.getStart(source), text: prefix })
        edits.push({ offset: node.end, text: suffix })
      }

      function instrument(component: ts.FunctionDeclaration | ts.FunctionExpression, name: string) {
        if (!component.body) throw new Error(`Update the renderer Profiler probe for ${name}`)
        let profileId = JSON.stringify(name)
        if (name === 'ThreadRow') {
          const props = component.parameters[0]?.name
          if (!props || !ts.isObjectBindingPattern(props)) {
            throw new Error('The renderer row probe needs destructured props')
          }
          // ThreadList supplies the existing DOM thread ID to the memoized body in tests.
          edits.push({ offset: props.getStart(source) + 1, text: ' __amcThreadId,' })
          profileId = "'row:' + __amcThreadId"
        }

        function visitReturns(node: ts.Node) {
          if (ts.isFunctionLike(node)) return
          if (ts.isReturnStatement(node) && node.expression) {
            wrap(node.expression, `__amcProfile(${profileId}, `, ')')
          }
          ts.forEachChild(node, visitReturns)
        }
        visitReturns(component.body)

        function visitJsx(node: ts.Node) {
          if (
            name === 'Composer' &&
            ts.isJsxElement(node) &&
            node.openingElement.tagName.getText(source) === 'footer'
          ) {
            wrap(node, "{__amcProfile('footer', ", ')}')
          }
          if (
            name === 'ThreadList' &&
            ts.isJsxSelfClosingElement(node) &&
            node.tagName.getText(source) === 'ThreadRow'
          ) {
            const parent = node.parent
            const threadId = ts.isJsxElement(parent)
              ? parent.openingElement.attributes.properties.find(
                  (prop): prop is ts.JsxAttribute =>
                    ts.isJsxAttribute(prop) && prop.name.getText(source) === 'data-thread-id',
                )
              : undefined
            const initializer = threadId?.initializer
            if (!initializer || !ts.isJsxExpression(initializer) || !initializer.expression) {
              throw new Error('The renderer row probe needs a thread ID on the list option')
            }
            edits.push({
              offset: node.tagName.end,
              text: ` __amcThreadId={${initializer.expression.getText(source)}}`,
            })
          }
          ts.forEachChild(node, visitJsx)
        }
        if (name === 'Composer' || name === 'ThreadList') visitJsx(component.body)
      }

      for (const statement of source.statements) {
        if (!ts.canHaveModifiers(statement)) continue
        if (
          !ts
            .getModifiers(statement)
            ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
        ) {
          continue
        }
        if (
          ts.isFunctionDeclaration(statement) &&
          statement.name &&
          components.has(statement.name.text)
        ) {
          instrument(statement, statement.name.text)
        }
        if (ts.isVariableStatement(statement)) {
          for (const declaration of statement.declarationList.declarations) {
            const row = getThreadRow(declaration)
            if (row) instrument(row, 'ThreadRow')
          }
        }
      }

      if (!edits.length) return
      let instrumented = code
      for (const { offset, text } of edits.sort((a, b) => b.offset - a.offset)) {
        instrumented = instrumented.slice(0, offset) + text + instrumented.slice(offset)
      }
      return `import { profile as __amcProfile } from ${JSON.stringify(profile)}\n${instrumented}`
    },
  }
}
