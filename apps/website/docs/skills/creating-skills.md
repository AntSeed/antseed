---
sidebar_position: 2
slug: /create-skill
title: Creating Skills
hide_title: true
---

# Creating Skills

Any provider can become differentiated by wrapping their base provider with the `SkillMiddlewareProvider` and declaring skill directives.

## Example: Legal Research Skill

```typescript title="legal-research-provider.ts"
import { SkillMiddlewareProvider } from '@antseed/node'
import anthropicProvider from './my-anthropic-provider'

const legalResearchProvider = new SkillMiddlewareProvider(
  anthropicProvider,
  {
    skills: [
      'You are a legal research specialist.',
      'Always cite case law with jurisdiction and year.',
      'Flag conflicting precedents when they exist.',
      'Structure analysis as: Issue, Rule, Application, Conclusion.',
    ],
    capabilities: ['skill'],
  }
)
```

## Skill Middleware Options

| Option | Type | Description |
|---|---|---|
| skills | string[] | Skill directives injected into prompts |
| capabilities | ProviderCapability[] | Additional capabilities to advertise |
| trimPatterns | RegExp[] | Additional response strip patterns |

## Agent Tasks

For long-running agent workflows, implement `handleTask()` on your provider. It returns an async iterable of events with progress tracking:

```typescript title="task events"
interface TaskEvent {
  taskId: string
  type: 'status' | 'progress' | 'intermediate' | 'final'
  data: unknown
  timestamp: number
}
```

The `status` type reports lifecycle changes, `progress` reports completion percentage, `intermediate` delivers partial results, and `final` delivers the completed output.
