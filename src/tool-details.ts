/** Standard AHP content references keep large tool bodies off chat snapshots.
 * Native history remains authoritative; these immutable blobs are projections.
 */
export const TOOL_DETAIL_LIMIT = 4096;
export const TOOL_RESULT_TYPE = 'application/vnd.amplifier.tool-result+json';
type Json = Record<string, any>;
type Save = (block: Json) => Promise<Json>;
export async function toolInputDetail(value: unknown, save: Save): Promise<any> {
  if (value === undefined) return undefined;
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) <= TOOL_DETAIL_LIMIT) return text;
  const ref = await save({data: Buffer.from(text).toString('base64'), mimeType: 'application/json'});
  return {uri: ref.uri, contentType: ref.contentType};
}
export async function toolResultDetail(result: Json, save: Save): Promise<Json> {
  const text = JSON.stringify(result);
  if (Buffer.byteLength(text) <= TOOL_DETAIL_LIMIT) return result;
  const ref = await save({data: Buffer.from(text).toString('base64'), mimeType: TOOL_RESULT_TYPE});
  return {success: result.success, pastTenseMessage: result.pastTenseMessage,
    ...(result.error ? {error: result.error} : {}),
    content: [{type: 'resource', uri: ref.uri, contentType: ref.contentType}]};
}
