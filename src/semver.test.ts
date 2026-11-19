import { assert, test } from 'orca/testing'
import { satisfies } from './semver'

test('reads the ranges peerDependencies use', () => {
  const yes: [string, string][] = [
    ['10.6.7', '^10.6.7'],
    ['3.3.1', '^3.0.0-next.0'],
    ['3.3.1', '^1 || ^2 || ^3 || ^3.0.0-next.0'],
    ['5.58.0', '>= 4'],
    ['5.58.0', '>=5.29.0'],
    ['5.1.1', '5.1.1'],
    ['1.64.1', '*'],
    ['10.6.3', '^0.0.0-0 || ^10.6.0-0 || ^11.0.0-0'],
    ['0.2.5', '^0.2.0'],
    ['1.2.9', '~1.2.3'],
    ['1.9.0', '1.x'],
    ['2.5.0', '1.0.0 - 2'],
    ['6.0.3', '^5.0.0 || ^6.0.0']
  ]
  const no: [string, string][] = [
    ['10.6.3', '^10.6.7'],
    ['5.1.0', '5.1.1'],
    ['7.0.2', '^6.0.0'],
    ['7.0.2', '^5.0.0 || ^6.0.0'],
    ['1.7.0', '^0.1.15 || ^0.2.0'],
    ['0.3.0', '^0.2.0'],
    ['1.3.0', '~1.2.3'],
    ['3.0.0', '1.0.0 - 2'],
    ['4.0.0', '>=2 <4']
  ]
  for (const [v, r] of yes) assert.equal(satisfies(v, r), true, `${v} in ${r}`)
  for (const [v, r] of no) assert.equal(satisfies(v, r), false, `${v} not in ${r}`)
})

test('says null when it cannot tell', () => {
  assert.equal(satisfies('1.0.0', 'latest'), null)
  assert.equal(satisfies('1.0.0', 'npm:other@1'), null)
  assert.equal(satisfies('npm:@x/y@8', '^8'), null)
  assert.equal(satisfies('1.2', '^1'), null)
})
