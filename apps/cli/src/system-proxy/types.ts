export type SystemProxySource = string

export type SystemProxyJsonPath = readonly string[]

export type SystemProxyRequestTransform =
  | {
    readonly kind: 'chat-completions-from-messages'
    readonly messagesPath: SystemProxyJsonPath
    readonly modelPath?: SystemProxyJsonPath
    readonly missingModel?: string
    readonly stream?: boolean
  }
  | {
    readonly kind: 'responses-from-messages'
    readonly messagesPath: SystemProxyJsonPath
    readonly modelPath?: SystemProxyJsonPath
    readonly stream?: boolean
  }

export type SystemProxyResponseTransform =
  | {
    readonly kind: 'conversation-sse'
    readonly assistantParent?: 'request-parent' | 'user-message'
  }
  | {
    readonly kind: 'responses-sse'
    readonly injectResponseId?: boolean
    readonly stripDataType?: boolean
    readonly stripItemPhase?: boolean
    readonly emptyContentPartDoneText?: boolean
    readonly emptyOutputItemDoneContent?: boolean
    readonly messageOutputIndex?: number
    readonly messageItemId?: string
  }

export interface SystemProxyCorsRule {
  readonly allowOrigin?: 'request' | '*' | string
  readonly allowCredentials?: boolean
  readonly allowMethods?: readonly string[]
  readonly allowHeaders?: 'request' | readonly string[]
  readonly exposeHeaders?: readonly string[]
  readonly maxAgeSeconds?: number
}

export interface SystemProxyForwardRule {
  readonly source: SystemProxySource
  readonly targetPath?: string
  readonly headers?: 'preserve' | 'browser-sse'
  readonly stripHeaders?: readonly string[]
  readonly request?: SystemProxyRequestTransform
  readonly response?: SystemProxyResponseTransform
  readonly cors?: SystemProxyCorsRule
}

export interface SystemProxyConfigPatch {
  readonly configPath: string
  readonly providerKey: string
  readonly npm: string
  readonly providerName: string
  readonly baseURL: string
  readonly modelFormat: 'peer-routed'
}

export interface SystemProxyProfile {
  readonly name: string
  readonly displayName: string
  readonly kind?: 'proxy' | 'config-patch'
  readonly domains: readonly string[]
  readonly pathPrefixes: readonly string[]
  readonly forward?: SystemProxyForwardRule
  readonly configPatch?: SystemProxyConfigPatch
}

export interface SystemProxyState {
  port: number
  peerId: string
  defaultModel?: string
  activeProfileNames: string[]
  running: boolean
}
