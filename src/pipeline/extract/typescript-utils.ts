import * as ts from 'typescript'

export function unparenthesizeExpression(expression: ts.Expression): ts.Expression {
  let current = expression
  while (ts.isParenthesizedExpression(current)) {
    current = current.expression
  }
  return current
}
