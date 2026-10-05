import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RecordingAttachment } from '../src/shared/types'
import { electronExecutable, waitFor } from './helpers/env'
import { type GuiSession, launchGui } from './helpers/session'
import { expect, test } from './helpers/test'

const AGENT_SCRIPT = String.raw`
const write = (value) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n')
let mcp
const tool = async (name, args) => {
  const response = await fetch(mcp.url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...Object.fromEntries(mcp.headers.map(h => [h.name, h.value])) }, body: JSON.stringify({jsonrpc:'2.0', id:1, method:'tools/call', params:{name,arguments:args}}) })
  const reply = await response.json()
  if (reply.error) throw new Error(reply.error.message)
  return reply.result
}
const handle = async ({id,method,params}) => {
  if (id === undefined || !method) return
  if (method === 'initialize') return write({id,result:{protocolVersion:1,agentCapabilities:{promptCapabilities:{image:true},mcpCapabilities:{http:true}},authMethods:[]}})
  if (method === 'session/new') { mcp=params.mcpServers.find(s=>s.url); return write({id,result:{sessionId:'recording-test'}}) }
  if (method === 'session/prompt') {
    const text=params.prompt.filter(b=>b.type==='text').map(b=>b.text).join('\n')
    const clip=/ID ([a-f0-9-]{36})/.exec(text)?.[1]
    const info=await tool('recording_info',{recordingId:clip})
    const metadata=JSON.parse(info.content[0].text)
    const frame=await tool('recording_frame',{recordingId:clip,index:1})
    const range=await tool('recording_frames',{recordingId:clip,startMs:metadata.timestamps[0],endMs:metadata.timestamps[Math.min(5,metadata.frameCount-1)],fps:30})
    const outside=await tool('recording_frame',{recordingId:clip,index:metadata.frameCount})
    const oversized=await tool('recording_frames',{recordingId:clip,startMs:0,endMs:metadata.durationMs,fps:30})
    const other=await tool('recording_info',{recordingId:'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'})
    const result={imageCount:params.prompt.filter(b=>b.type==='image').length,info:metadata,frame:frame.content.find(b=>b.type==='text')?.text,frameImage:frame.content.some(b=>b.type==='image'),rangeImages:range.content.filter(b=>b.type==='image').length,outside:outside.isError,oversized:oversized.isError,other:other.isError}
    write({method:'session/update',params:{sessionId:params.sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:JSON.stringify(result)}}}})
    return write({id,result:{stopReason:'end_turn'}})
  }
  write({id,error:{code:-32601,message:'unsupported'}})
}
let buffer=''
process.stdin.setEncoding('utf8')
process.stdin.on('data',chunk=>{buffer+=chunk;let end;while((end=buffer.indexOf('\n'))!==-1){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);if(line)handle(JSON.parse(line)).catch(error=>write({id:JSON.parse(line).id,error:{code:-32603,message:error.message}}))}})
`

async function useAgent(session: GuiSession) {
  const script = join(session.fixture.base, 'recording-agent.cjs')
  writeFileSync(script, AGENT_SCRIPT)
  writeFileSync(
    join(session.fixture.userData, 'agents.json'),
    JSON.stringify({
      Recording: {
        command: electronExecutable(),
        args: [script],
        env: { ELECTRON_RUN_AS_NODE: '1' },
      },
    }),
  )
  await session.chrome.evaluate(() => window.gui.checkAgents())
  await waitFor(
    async () => (await session.state()).agents.some((agent) => agent.id === 'custom:Recording'),
    'recording agent listed',
  )
  await session.chrome.evaluate(() => window.gui.setAgent('custom:Recording'))
  await waitFor(
    async () => (await session.chatSnapshot()).meta.agentId === 'custom:Recording',
    'recording agent selected',
  )
}

async function animate(session: GuiSession) {
  const preview = await session.previewPage()
  await preview.evaluate(() => {
    const box = document.createElement('div')
    box.style.cssText =
      'position:fixed;left:20px;top:20px;width:80px;height:80px;background:red;z-index:999'
    document.body.append(box)
    box.animate([{ transform: 'translateX(0)' }, { transform: 'translateX(400px)' }], {
      duration: 1000,
      iterations: Infinity,
      direction: 'alternate',
    })
  })
}

async function record(session: GuiSession): Promise<RecordingAttachment> {
  const attached = session.chat.evaluate(
    () =>
      new Promise<RecordingAttachment>((resolve) => {
        const off = window.gui.onRecordingAttach((clip) => {
          off()
          resolve(clip)
        })
      }),
  )
  await session.chrome.getByRole('button', { name: 'Record preview', exact: true }).click()
  await expect(
    session.chrome.getByRole('button', { name: 'Stop preview recording', exact: true }),
  ).toBeVisible()
  await session.chrome.waitForTimeout(1800)
  await session.chrome.getByRole('button', { name: 'Stop preview recording', exact: true }).click()
  await expect(session.chat.getByLabel('Attached recordings').locator('video')).toBeVisible({
    timeout: 15000,
  })
  return attached
}

test('preview video plays, sends overview images, and exposes exact frames and bounded ranges', async ({
  launch,
}, testInfo) => {
  const session = await launch({ fixture: 'vite' })
  await session.waitForPreview()
  await useAgent(session)
  await animate(session)
  const clip = await record(session)
  expect(clip.frameCount).toBeGreaterThan(20)
  expect(clip.durationMs).toBeGreaterThan(1000)
  expect(clip.width).toBeLessThanOrEqual(1568)
  const video = session.chat.getByLabel('Attached recordings').locator('video')
  await expect(video).toBeVisible()
  await expect
    .poll(() => video.evaluate((node: HTMLVideoElement) => node.readyState))
    .toBeGreaterThanOrEqual(1)
  await expect
    .poll(() => video.evaluate((node: HTMLVideoElement) => Number.isFinite(node.duration)))
    .toBe(true)
  await video.evaluate((node: HTMLVideoElement) => node.play())
  await expect
    .poll(() => video.evaluate((node: HTMLVideoElement) => node.currentTime))
    .toBeGreaterThan(0)
  await session.shot('preview-recording-attached')
  await session.chat.locator('[data-composer]').fill('Inspect the animation easing.')
  await session.chat.getByRole('button', { name: 'Send', exact: true }).click()
  const { turn } = await session.waitForTurn(0)
  expect(turn.status).toBe('done')
  expect(turn.recordings).toEqual([clip])
  await expect(session.chat.getByLabel('Attached recordings')).toHaveCount(0)
  const reply = turn.items.find((item) => item.kind === 'text')
  if (reply?.kind !== 'text') throw new Error('Missing agent reply')
  const result = JSON.parse(reply.text)
  expect(result.imageCount).toBe(3)
  expect(result.frameImage).toBe(true)
  expect(result.frame).toContain('Frame 1 at')
  expect(result.rangeImages).toBeGreaterThan(1)
  expect(result.outside).toBe(true)
  expect(result.oversized).toBe(true)
  expect(result.other).toBe(true)
  const timestamps: number[] = result.info.timestamps
  expect(timestamps.every((at, index) => index === 0 || at > timestamps[index - 1])).toBe(true)
  const projects = readdirSync(join(session.fixture.userData, 'recordings'))
  const directory = join(session.fixture.userData, 'recordings', projects[0], clip.id)
  const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'))
  expect(manifest.timestamps).toEqual(timestamps)
  expect(readFileSync(join(directory, 'video.webm')).subarray(0, 4).toString('hex')).toBe(
    '1a45dfa3',
  )
  expect(
    readFileSync(join(directory, '0.jpg')).equals(
      readFileSync(join(directory, `${Math.floor(clip.frameCount / 2)}.jpg`)),
    ),
  ).toBe(false)
  await session.chat.evaluate((id) => window.gui.discardRecording(id), clip.id)
  expect(readFileSync(join(directory, 'video.webm')).length).toBeGreaterThan(0)
  await session.close()
  const reopened = await launchGui(session.fixture, { fixture: 'vite' }, testInfo)
  try {
    await reopened.waitForPreview()
    await waitFor(
      async () => (await reopened.chatSnapshot()).turns.length === 1,
      'saved recording turn loaded',
    )
    expect((await reopened.chatSnapshot()).turns[0].recordings).toEqual([clip])
    const restoredVideo = reopened.chat.locator('video')
    await expect
      .poll(() => restoredVideo.evaluate((node: HTMLVideoElement) => node.readyState))
      .toBeGreaterThanOrEqual(1)
    await restoredVideo.evaluate((node: HTMLVideoElement) => {
      node.currentTime = 0.7
    })
    await expect
      .poll(() => restoredVideo.evaluate((node: HTMLVideoElement) => node.currentTime))
      .toBeGreaterThanOrEqual(0.6)
  } finally {
    await reopened.close()
  }
})

test('removing an unsent recording deletes its files and does not send a turn', async ({
  launch,
}) => {
  const session = await launch({ fixture: 'vite' })
  await session.waitForPreview()
  await animate(session)
  const clip = await record(session)
  await session.chat.getByRole('button', { name: 'Remove recording' }).click()
  await expect(session.chat.getByLabel('Attached recordings')).toHaveCount(0)
  await waitFor(
    () =>
      readdirSync(join(session.fixture.userData, 'recordings')).every(
        (key) => !readdirSync(join(session.fixture.userData, 'recordings', key)).includes(clip.id),
      ),
    'recording files removed',
  )
  expect((await session.chatSnapshot()).turns).toHaveLength(0)
})

test('switching tabs stops capture and attaches the clip to its original project', async ({
  launch,
}) => {
  const session = await launch({ fixture: 'vite' })
  await session.waitForPreview()
  await animate(session)
  const original = (await session.state()).activeTab
  const attached = session.chat.evaluate(
    () =>
      new Promise<RecordingAttachment>((resolve) => {
        const off = window.gui.onRecordingAttach((clip) => {
          off()
          resolve(clip)
        })
      }),
  )
  await session.chrome.getByRole('button', { name: 'Record preview', exact: true }).click()
  await expect(
    session.chrome.getByRole('button', { name: 'Stop preview recording', exact: true }),
  ).toBeVisible()
  await session.chrome.waitForTimeout(800)
  await session.chrome.evaluate(() => window.gui.newTab())
  const clip = await attached
  expect(clip.frameCount).toBeGreaterThan(0)
  expect(clip.durationMs).toBeLessThan(10_000)
  await session.chrome.evaluate((id) => window.gui.selectTab(id), original)
  await expect(session.chat.getByLabel('Attached recordings').locator('video')).toBeVisible()
  await expect(
    session.chrome.getByRole('button', { name: 'Record preview', exact: true }),
  ).toBeEnabled()
})
