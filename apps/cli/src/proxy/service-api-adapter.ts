export {
  createStreamingAdapter,
  detectRequestServiceApiProtocol,
  inferProviderDefaultServiceApiProtocols,
  requestTransformFailureReason,
  selectTargetProtocolForRequest,
  transformRequest,
  transformResponse,
} from '@antseed/api-adapter'

export type {
  ServiceApiRequestTransformOptions,
  ServiceApiRequestTransformResult,
  ServiceApiResponseTransformOptions,
  ServiceApiStreamTransformOptions,
  SerializedHttpResponse,
  SerializedHttpResponseChunk,
  ServiceApiProtocol,
  StreamingResponseAdapter,
  TargetProtocolSelection,
} from '@antseed/api-adapter'
