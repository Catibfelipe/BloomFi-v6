// The link version has no local AI (it runs inside another site's frame, without WebGPU downloads).
const no = () => Promise.reject(Object.assign(new Error('ai_unsupported'), { code: 'ai_unsupported' }));
export const callEngine = no;
export function shutEngine() {}
