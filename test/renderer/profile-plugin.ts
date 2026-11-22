import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const renderer = fileURLToPath(new URL('../../apps/desktop/src/renderer/src/', import.meta.url))
const profile = fileURLToPath(new URL('./profile.ts', import.meta.url))
const components: Record<string, string> = {
  'app.tsx': 'App',
  'components/app-sidebar.tsx': 'AppSidebar',
  'components/thread-list.tsx': 'ThreadList',
  'components/thread-view.tsx': 'ThreadView',
  'components/composer.tsx': 'Composer',
  'components/recipient-field.tsx': 'RecipientField',
  'features/composer/footer.tsx': 'ComposerFooter',
  'features/composer/header-fields.tsx': 'SubjectField',
  'features/mailbox/mail-workspace.tsx': 'MailWorkspace',
  'features/thread-list/thread-row.tsx': 'ThreadRow',
}

function getMemoRender(declaration: ts.VariableDeclaration) {
  const { initializer } = declaration
  if (
    initializer &&
    ts.isCallExpression(initializer) &&
    ts.isIdentifier(initializer.expression) &&
    initializer.expression.text === 'memo'
  ) {
    const render = initializer.arguments[0]
    if (render && ts.isFunctionExpression(render)) return render
  }
}

// The renderer project adds probes to the real return values before JSX compilation.
export function profileRenderer() {
  return {
    name: 'amc-renderer-profiler',
    enforce: 'pre' as const,
    transform(code: string, id: string) {
      if (!id.startsWith(renderer)) return
      const name = components[id.slice(renderer.length)]
      if (!name) return
      const source = ts.createSourceFile(id, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
      const edits: { offset: number; text: string }[] = []
      const wrap = (node: ts.Node, prefix: string, suffix: string) => {
        edits.push({ offset: node.getStart(source), text: prefix })
        edits.push({ offset: node.end, text: suffix })
      }

      function instrument(component: ts.FunctionDeclaration | ts.FunctionExpression, name: string) {
        if (!component.body) throw new Error(`Update the renderer Profiler probe for ${name}`)
        let profileId = JSON.stringify(name === 'ComposerFooter' ? 'footer' : name)
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
        if (name === 'ThreadList') visitJsx(component.body)
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
        if (ts.isFunctionDeclaration(statement) && statement.name && statement.name.text === name) {
          instrument(statement, name)
        }
        if (ts.isVariableStatement(statement)) {
          for (const declaration of statement.declarationList.declarations) {
            if (!ts.isIdentifier(declaration.name) || declaration.name.text !== name) continue
            const render = getMemoRender(declaration)
            if (render) instrument(render, name)
          }
        }
      }

      if (!edits.length) throw new Error(`Update the renderer Profiler probe for ${name}`)
      let instrumented = code
      for (const { offset, text } of edits.sort((a, b) => b.offset - a.offset)) {
        instrumented = instrumented.slice(0, offset) + text + instrumented.slice(offset)
      }
      return `import { profile as __amcProfile } from ${JSON.stringify(profile)}\n${instrumented}`
    },
  }
}
