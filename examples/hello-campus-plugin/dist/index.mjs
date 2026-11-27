// Reference example artifact bytes. The host verifies integrity only; it never evaluates plugin artifact code.
// The callable greeting behavior is host-owned in apps/api/src/app.mjs for this built-in example.
export async function greetCampus({ userId, payload }) {
  return {
    greeting: `欢迎使用河南工业大学扩展卡片 (${userId})`,
    campus: payload?.campus || '莲花街校区',
    timestamp: new Date().toISOString()
  };
}
