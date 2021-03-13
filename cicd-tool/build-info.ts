// This is just example file.
// At build time, real file is generated.

export const escapedBuildId = 'aa\\-bbcc'

export const pages = {
  '/p-get-initial-props': () => require('./.next/serverless/pages/p-get-initial-props.js'),
  '/p-get-server-side-props': () => require('./.next/serverless/pages/p-get-server-side-props.js'),
  '/p-get-static-props': () => require('./.next/serverless/pages/p-get-static-props.js'),
  '/posts/[postId]': () => require('./.next/serverless/pages/posts/[postId].js'),
}

export const dynamicRoutes = [
  {"src":"^/posts/(?<postId>[^/]+?)(?:/)?$","dest":"/posts/[postId]?postId=$postId"},
]

