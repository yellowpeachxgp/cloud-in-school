export async function greetCampus({ userId, payload }) {
  return {
    greeting: `欢迎使用河南工业大学扩展卡片 (${userId})`,
    campus: payload?.campus || '莲花街校区',
    timestamp: new Date().toISOString()
  };
}
