// 发布身份校验：在 CI 真正 publish 之前先把"发错地方 / 发错版本"挡掉。
//
// 这里刻意不联网，只看 package.json 与传入的标签，因为它要在依赖安装之前就能跑。
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const PACKAGE_NAME = 'tokens-dsh-web-search'
const REGISTRY = 'https://npm.tokensapi.ai/'
const STABLE_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

export function validateRelease(manifest, tag) {
  if (manifest.name !== PACKAGE_NAME) {
    throw new Error(`Unexpected release package name: ${manifest.name}`)
  }
  // 私有源是硬要求：publishConfig 缺失或指向 npmjs 时一律拒绝，
  // 避免把内置插件发到公共 registry。
  if (manifest.publishConfig?.registry !== REGISTRY || manifest.publishConfig?.access === 'public') {
    throw new Error(`Release must target the private registry ${REGISTRY}`)
  }
  // 只允许稳定版占用 latest 标签；预发布版本需要另行指定 dist-tag。
  if (!STABLE_SEMVER.test(manifest.version)) {
    throw new Error(`Only stable versions may update latest: ${manifest.version}`)
  }
  if (tag !== `v${manifest.version}`) {
    throw new Error(`Release tag ${tag} must match package.json version ${manifest.version}`)
  }
  return manifest.version
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const version = validateRelease(manifest, process.argv[2])
  console.log(`Validated ${manifest.name}@${version} for ${REGISTRY}`)
}
