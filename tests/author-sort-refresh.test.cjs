const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { resolve } = require('node:path')
const { runInNewContext } = require('node:vm')
const test = require('node:test')

const script = readFileSync(resolve(__dirname, '../pages/bookshelf/authors.vue'), 'utf8').split('<script>')[1].split('</script>')[0]
const context = { module: { exports: {} }, window: { innerWidth: 1080 }, console: { log() {}, error() {} } }
runInNewContext(script.replace('export default', 'module.exports ='), context)
const component = context.module.exports

function page() {
  const pending = []
  const state = {
    ...component.data(), currentLibraryId: 'one', authorSortBy: 'numBooks', authorSortDesc: true,
    $nativeHttp: { get(url) { return new Promise((resolve, reject) => pending.push({ url, resolve, reject })) } },
    $eventBus: { $emit() {}, $off() {} }, $socket: { $off() {} }
  }
  for (const [name, method] of Object.entries(component.methods)) state[name] = method.bind(state)
  return { state, pending }
}

test('slower old sort responses cannot overwrite the selected order', async () => {
  const { state, pending } = page()
  const old = state.init()
  state.authorSortBy = 'name'
  state.authorSortDesc = false
  const current = state.init()
  pending[1].resolve({ authors: [{ id: 'selected' }] })
  await current
  pending[0].resolve({ authors: [{ id: 'obsolete' }] })
  await old
  assert.equal(state.authors[0].id, 'selected')
})

test('author additions and updates reload the selected server order', async () => {
  for (const event of ['authorAdded', 'authorUpdated']) {
    const { state, pending } = page()
    state.authors = [{ id: 'existing', name: 'Zoe' }]
    state[event]({ id: 'new', name: 'Ada' })
    assert.equal(pending.length, 1, `${event} must fetch instead of patching a sorted list`)
    assert.equal(pending[0].url, '/api/libraries/one/authors?sort=numBooks&desc=1')
    pending[0].resolve({ authors: [{ id: 'new', name: 'Ada' }, { id: 'existing', name: 'Zoe' }] })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(state.authors[0].id, 'new')
  }
})

test('a removal invalidates pending snapshots and reloads the remaining order', async () => {
  const { state, pending } = page()
  state.authors = [{ id: 'removed' }]
  const old = state.init()
  state.authorRemoved({ id: 'removed' })
  assert.equal(state.authors.length, 0)
  pending[0].resolve({ authors: [{ id: 'removed' }] })
  await old
  assert.equal(state.authors.length, 0)
  assert.equal(pending.length, 2)
  pending[1].resolve({ authors: [] })
  await new Promise((resolve) => setImmediate(resolve))
})

test('a previous-library failure cannot clear the newer library result', async () => {
  const { state, pending } = page()
  const old = state.init()
  state.currentLibraryId = 'two'
  const current = state.init()
  pending[1].resolve({ authors: [{ id: 'two' }] })
  await current
  pending[0].reject(new Error('Old library offline'))
  await old
  assert.equal(state.authors[0].id, 'two')
  assert.equal(state.loading, false)
})

test('unmount prevents an in-flight request from publishing results', async () => {
  const { state, pending } = page()
  const request = state.init()
  component.beforeDestroy.call(state)
  pending[0].resolve({ authors: [{ id: 'late' }] })
  await request
  assert.equal(state.authors.length, 0)
})
