import { flatten } from "lodash"

import { LogOpts } from "./types"

interface Node {
  children: any[]
}

type LogOptsResolvers = {[K in keyof LogOpts]?: Function}

// TODO Tail call optimization?
export function getNodeListFromTree<T extends Node>(node: T): T[] {
  let arr: T[] = []
  arr.push(node)
  if (node.children.length === 0) {
    return arr
  }
  return arr.concat(flatten(node.children.map(child => getNodeListFromTree(child))))
}

export function traverseTree<T extends Node>(root: T, visitNode: Function): void {
  let stack: any[] = []
  stack.push(root)

  while (stack.length !== 0) {
    const node = stack.pop()
    visitNode(node)
    if (node.children.length !== 0) {
      for (let i = node.children.length - 1; i >= 0; i--) {
        stack.push(node.children[i])
      }
    }
  }
}

function mergeWithResolvers(objA: any, objB: any, resolvers: any = {}) {
  const returnObj = { ...objA, ...objB }
  return Object.keys(resolvers).reduce((acc, key) => {
    acc[key] = resolvers[key](objA, objB)
    return acc
  }, returnObj)
}

export function mergeLogOpts(prevOpts: LogOpts, nextOpts: LogOpts, resolvers: LogOptsResolvers) {
  return mergeWithResolvers(prevOpts, nextOpts, resolvers)
}
