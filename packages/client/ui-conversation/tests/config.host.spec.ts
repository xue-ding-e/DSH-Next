import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import * as HostPlugin from '../src/index.ts'
import { liveConfig, omitsGeneratedPage } from '../../../settings/settings/tests/live-config.ts'
import { plainConfig } from '../../../settings/settings/src/schema.ts'
import { DEFAULT_SESSION_REFERENCE_NAVIGATION } from '../src/reference-navigation-settings.ts'
import {
  DEFAULT_BUSY_ENTER_BEHAVIOR, Config, apply,
} from '@deepseek-ai/dsh-client-ui-conversation'


describe('ui-conversation host', () => {
  it('registers, validates, and disposes the durable busy-Enter preference', async () => {
    const ctx = new Context()
    const configuration = await liveConfig(ctx, { Config, apply })
    const { fiber } = configuration
    expect(plainConfig(configuration.fiber.effectiveConfig)).toEqual({
      busyEnter: DEFAULT_BUSY_ENTER_BEHAVIOR,
      sessionReferenceNavigation: DEFAULT_SESSION_REFERENCE_NAVIGATION,
    })
    await configuration.update({ busyEnter: 'steer' })
    expect(plainConfig(configuration.fiber.effectiveConfig)).toEqual({ busyEnter: 'steer', sessionReferenceNavigation: DEFAULT_SESSION_REFERENCE_NAVIGATION })
    await configuration.update({ sessionReferenceNavigation: { gesture: 'custom', control: true, shift: true } })
    expect(plainConfig(configuration.fiber.effectiveConfig)).toMatchObject({
      sessionReferenceNavigation: { ...DEFAULT_SESSION_REFERENCE_NAVIGATION, gesture: 'custom', control: true, shift: true },
    })
    await expect(configuration.update({ sessionReferenceNavigation: { gesture: 'invalid' } })).rejects.toThrow()
    await expect(configuration.update({ busyEnter: 'invalid' })).rejects.toThrow()
    await fiber.dispose()
  })
})

it('keeps its own instance off the generated Settings pages', () => omitsGeneratedPage(ctx => ctx.plugin(HostPlugin)))
