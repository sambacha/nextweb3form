import * as path from 'path'
import * as fs from 'fs'
import rimraf from "rimraf"
import execa from "execa"
import { Builder } from '@sls-next/lambda-at-edge'
import regexEscape from 'regex-escape'
import archiver from 'archiver';
import { glob } from '@vercel/build-utils';
import packageJson from '../package.json'

const getAllFilesInDirectory = async (basePath: string) => {
  const fsRefs = await glob('**', { cwd: basePath })
  return Object.keys(fsRefs)
}

export async function generateZipBundle(filesNames: string[], absBaseDir: string, outputPath: string) {
  return new Promise<string>((resolve) => {
    const output = fs.createWriteStream(outputPath);
    output.on('close', () => resolve(outputPath));

    const archive = archiver('zip', {
      zlib: { level: 5 },
    });
    archive.pipe(output);

    for (const file of filesNames) {
      const absPath = path.join(absBaseDir, file)
      archive.append(fs.createReadStream(absPath), { name: file });
    }

    archive.finalize();
  });
}

// The builder wraps nextJS in Compatibility layers for Lambda@Edge; handles the page
// manifest and creating the default-lambda and api-lambda. The final output is an assets
// folder which can be uploaded to s3 on every deploy.
const nextConfigDir = '.';
const outputDir = path.join(nextConfigDir, ".serverless_nextjs");

const options = {
  cmd: './node_modules/.bin/next',
  cwd: path.join(process.cwd(), nextConfigDir),
  args: ['build']
}

const builder = new Builder(
  nextConfigDir,
  outputDir,
  options,
);

const getDynamicRoutesDestQS = (routesKeyValues: Record<string,string>) => {
  // arr = ['postId=$postId', 'type=$type']
  const arr = Object.keys(routesKeyValues).reduce((prev, current) => {
    return [...prev, `${current}=$${routesKeyValues[current]}`]
  }, [])
  return arr.join('&')
}

const replaceToEscape = (str: string) => {
  return str.replace(/-/g,'\\-')
    .replace(/\[/g,'\\[')
    .replace(/\]/g,'\\]')
}

type NextLambdaType = 'PAGE' | 'API'
const getLambdaName = (type: NextLambdaType, buildId: string) => {
  return type === 'API'
    ? `${packageJson.name}-next-api-${buildId}`
    : `${packageJson.name}-next-page-${buildId}`
}

const run = async () => {
  console.log('===================== start next build')

  rimraf.sync('build')
  console.log("deleted 'build' directory.")
  fs.mkdirSync('build')
  console.log("created 'build' directory.")

  await builder.build(true)

  ///////////////////////////////////////////////////////
  // proxy-config.json
  const alm = require('../.serverless_nextjs/api-lambda/manifest.json')
  const dlm = require('../.serverless_nextjs/default-lambda/manifest.json')
  const dlpm = require('../.serverless_nextjs/default-lambda/prerender-manifest.json')
  const dlrm = require('../.serverless_nextjs/default-lambda/routes-manifest.json')
  const dlpmRoutesKeys = Object.keys(dlpm.routes)
  const buildId = dlm.buildId
  if (typeof buildId !== 'string' || !/^[0-9a-zA-Z]+$/.test(buildId)) throw new Error('Wrong buildId')

  const dynamicRoutes = dlrm.dynamicRoutes.map((r: any) => ({
    src: r.namedRegex,
    dest: `${r.page}?${getDynamicRoutesDestQS(r.routeKeys)}`,
    check: true,
  }))

  const LAMBDA_NAME_FOR_PAGE = getLambdaName('PAGE', buildId)
  const LAMBDA_NAME_FOR_API = getLambdaName('API',buildId)

  const routes = [
    {
      // remove trailing slash
      "src": "^(?:\\/((?:[^\\/]+?)(?:\\/(?:[^\\/]+?))*))\\/$",
      "headers": { "Location": "/$1" },
      "status": 308,
      "continue": true
    },

    { handle: 'filesystem' },

    ...Object.keys(alm.apis.nonDynamic).map(key => ({
      _id: 'keys(alm.apis.nonDynamic)',
      src: `^${key}/?$`,
      dest: `/${LAMBDA_NAME_FOR_API}`,
      headers: {
        'x-nextjs-page': key,
      },
      check: true,
    })),

    ...dlrm.dataRoutes.filter((v: any) => {
      return !dlpmRoutesKeys.includes(v.page)
    }).map((r: any) => ({
      _id: 'dlrm.dataRoutes',
      src: r.dataRouteRegex.replace(/\\-/g,'-').replace(/-/g,'\\-'), // TODO: check `-` escape 하는게 맞는지...!
      dest: r.page,
      check: true,
    })),

    ...Object.keys(dlm.pages.ssr.nonDynamic).filter(key => {
      return key !== '/_error' && !dlpmRoutesKeys.includes(key)
    }).map(key => ({
      _id: 'dlm.pages.ssr.nonDynamic',
      src: `^${key.replace(/-/g,'\\-')}/?$`,
      dest: `/${LAMBDA_NAME_FOR_PAGE}`,
      headers: {
        'x-nextjs-page': key,
      },
      check: true,
    })),

    // { handle: 'resource' },           // it is not used by proxy
    // { "src": "/.*", "status": 404 },  // maybe it should be moved to down
    // { "handle": "miss" },             // it is not used by proxy
    // { "handle": "rewrite" },          // it is not used by proxy

    ...dlpmRoutesKeys.map(key => ({
      _id: 'dlpmRoutesKeys',
      src: `^${key.replace(/-/g,'\\-')}/?$`,
      dest: `/${LAMBDA_NAME_FOR_PAGE}`,
      headers: {
        'x-nextjs-page': key,
      },
      check: true,
    })),

    ...dynamicRoutes,

    ...dlrm.dynamicRoutes.map((r: any) => ({
      _id: 'dlrm.dynamicRoutes',
      src: `^${replaceToEscape(r.page)}/?$`,
      dest: `/${LAMBDA_NAME_FOR_PAGE}`,
      headers: {
        "x-nextjs-page": r.page,
      },
      check: true,
    })),

    { "handle": "hit" },
    { "handle": "error" },
    { "src": "/.*", "dest": "/404", "status": 404 },
  ]

  const staticRoutes = [
    ...Object.values(dlm.pages.html.nonDynamic)
      .map((v: string) => v.replace(/^pages/, ''))
      .map((v: string) => v.replace(/\.html$/, ''))
    ,
    ...Object.keys(dlm.publicFiles),
  ]

  const prerenders = {
    ...Object.keys(dlpm.routes).reduce((prev,key) => {
      const r = dlpm.routes[key]
      return {
        ...prev,
        [r.dataRoute]: { lambda: LAMBDA_NAME_FOR_PAGE },
        [key]: { lambda: LAMBDA_NAME_FOR_PAGE },
      }
    }, {})
  }

  const apiLength = Object.keys(alm.apis.dynamic).length + Object.keys(alm.apis.nonDynamic).length
  const pageLength = Object.keys(dlm.pages.ssr.dynamic).length + Object.keys(dlm.pages.ssr.nonDynamic).length
  const lambdaRoutes = [
    apiLength > 0 && `/${LAMBDA_NAME_FOR_API}`,
    pageLength > 0 && `/${LAMBDA_NAME_FOR_PAGE}`,
  ].filter(Boolean)

  const proxyConfig = { buildId: buildId, lambdaRoutes, prerenders, routes, staticRoutes }

  fs.writeFileSync('build/proxy-config.json', JSON.stringify(proxyConfig,null,2))
  console.log('===================== created build/proxy-config.json file.\n')

  ///////////////////////////////////////////////////////
  // build lambda function
  if (apiLength > 0) {
    const zipFilePath = await buildLambdaFunction({ alm, dlm, buildId, dlrm, dynamicRoutes, type: 'API' })
    console.log(`===================== '${zipFilePath}' is ready\n`)
  }

  if (pageLength > 0) {
    const zipFilePath = await buildLambdaFunction({ alm, dlm, buildId, dlrm, dynamicRoutes, type: 'PAGE' })
    console.log(`===================== '${zipFilePath}' is ready\n`)
  }

  ///////////////////////////////////////////////////////
  // ready static
  await makeStaticDirectoryToUploadS3(buildId)
  console.log(`===================== 'build/static' is ready\n`)

  console.log('===================== All done\n')
}

interface BuildLambdaFunctionParams {
  buildId: string
  type: NextLambdaType
  alm: any
  dlm: any
  dlrm: any
  dynamicRoutes: any
}
const buildLambdaFunction = async (params: BuildLambdaFunctionParams) => {
  const {buildId, type, alm, dlm, dlrm, dynamicRoutes} = params

  const dynamicRoutesSrcDest = dynamicRoutes.map((r:any) => ({ src: r.src, dest: r.dest }))
  const apiRequireCodes = Object.keys(alm.apis.nonDynamic).map(key => (
      `  '${key}': () => require('./${alm.apis.nonDynamic[key]}'),`
    )).join('\n')

  const nonDynamicPageRequireCodes = Object.keys(dlm.pages.ssr.nonDynamic)
    .filter(key => key !== '/_error')
    .map(key => (
      `  '${key}': () => require('./${dlm.pages.ssr.nonDynamic[key]}'),`
    )).join('\n')

  const dynamicPageRequireCodes = dlrm.dynamicRoutes.map((r: any) => (
      `  '${r.page}': () => require('./pages/${r.page}.js'),`
    )).join('\n')

  const pageBuildInfoTs = `
// This file is generated at build time. Don't modify manually.
export const dynamicRoutes = ${JSON.stringify(dynamicRoutesSrcDest,null,2)}
export const buildId = "${buildId}"
export const escapedBuildId = "${regexEscape(buildId)}"
export const pages = {
${type === 'PAGE' ? nonDynamicPageRequireCodes : ''}
${type === 'PAGE' ? dynamicPageRequireCodes : ''}
${type === 'API' ? apiRequireCodes : ''}
}`.trim()

  const targetBuildDir = `build/${getLambdaName(type, buildId)}`
  const sourceBuildDir = type === 'API'
    ? '.serverless_nextjs/api-lambda'
    : '.serverless_nextjs/default-lambda'
  const r1 = await execa('cp', ['-rv',sourceBuildDir,targetBuildDir])
  console.log(r1.stdout)

  fs.writeFileSync(`${targetBuildDir}/build-info.ts`, pageBuildInfoTs)
  fs.copyFileSync('cicd-tool/launcher.ts',`${targetBuildDir}/launcher.ts`)
  fs.copyFileSync('cicd-tool/bridge.ts',`${targetBuildDir}/bridge.ts`)

  // remove index.js for lambda@edge and make new index.js for lambda using launcher.ts
  fs.unlinkSync(`${targetBuildDir}/index.js`)
  const {stdout} = await execa('npx', ['ncc','build',`${targetBuildDir}/launcher.ts`,`-o`,`${targetBuildDir}/`])
  console.log(stdout)

  fs.unlinkSync(`${targetBuildDir}/launcher.ts`)
  fs.unlinkSync(`${targetBuildDir}/bridge.ts`)
  fs.unlinkSync(`${targetBuildDir}/build-info.ts`)

  // get bundle
  const absBuildDir = path.join(process.cwd(), targetBuildDir)
  const filePaths = await getAllFilesInDirectory(absBuildDir)
  console.log(filePaths)
  await generateZipBundle(filePaths, absBuildDir, `${targetBuildDir}.zip`)

  rimraf.sync(absBuildDir)
  return `${targetBuildDir}.zip`
}

const makeStaticDirectoryToUploadS3 = async (buildId: string) => {
  const r1 = await execa('cp', ['-rv','.serverless_nextjs/assets/public',`build/static`])
  console.log(r1.stdout)

  const r2 = await execa('cp', ['-rv','.serverless_nextjs/assets/_next',`build/static/_next`])
  console.log(r2.stdout)

  const htmlAbsDirPath = path.join(process.cwd(), `.serverless_nextjs/assets/static-pages/${buildId}`)
  const filePaths = await getAllFilesInDirectory(htmlAbsDirPath)
  const promises = filePaths.map(async relativePath => {
    // TODO: p-get-static-props.html은 걸러야함
    const source = path.join(htmlAbsDirPath, relativePath)
    const target = path.join(`build/static`,relativePath.replace(/\.html$/,''))
    const {stdout} = await execa('cp', ['-rv', source, target])
    console.log(stdout)
  })
  await Promise.all(promises)
}

if (require.main === module) {
  run()
}
