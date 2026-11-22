import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const renderer = fileURLToPath(new URL('../../apps/desktop/src/renderer/src/', import.meta.url))
const profile = fileURLToPath(new URL('./profile.ts', import.meta.url))
const components: Record<string, string> = {
  'app.tsx': 'App',
  'components/app-sidebar.tsx': 'AppSidebar',
  'components/thread-list.tsx': 'ThreadList',
  'components/sync-indicator.tsx': 'SyncIndicator',
  'components/thread-view.tsx': 'ThreadView',
  'components/composer.tsx': 'Composer',
  'components/recipient-field.tsx': 'RecipientField',
  'features/composer/footer.tsx': 'ComposerFooter',
  'features/composer/header-fields.tsx': 'SubjectField',
  'features/mailbox/mail-workspace.tsx': 'MailWorkspace',
  'features/thread-list/inbox-chrome.tsx': 'InboxSectionHeader',
  'features/thread-list/thread-row.tsx': 'ThreadRow',
  'features/triage-review/review-card.tsx': 'ReviewCard',
  'features/triage-review/triage-review.tsx': 'ReviewProgress',
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
        if (name === 'InboxSectionHeader') profileId = "'section:' + section"
        if (name === 'ThreadRow') {
          const props = component.parameters[0]?.name
          if (!props || !ts.isObjectBindingPattern(props)) {
            throw new Error('The renderer row probe needs destructured props')
          }
          // The subscribed row supplies its existing thread ID to the body probe.
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
      }

      function visitRowBody(node: ts.Node) {
        if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(source) === 'ThreadRow') {
          edits.push({ offset: node.tagName.end, text: ' __amcThreadId={id}' })
        }
        ts.forEachChild(node, visitRowBody)
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
            if (!ts.isIdentifier(declaration.name)) continue
            const render = getMemoRender(declaration)
            if (!render) continue
            if (declaration.name.text === name) instrument(render, name)
            if (name === 'ThreadRow' && declaration.name.text === 'SubscribedThreadRow') {
              visitRowBody(render.body)
            }
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
