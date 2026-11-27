// Reference example artifact bytes. The host verifies integrity only; it never evaluates plugin artifact code.
// The callable station-hours behavior is host-owned in apps/api/src/app.mjs for this built-in example.
export async function queryStationHours({ payload }) {
  return {
    station_name: payload?.station_name || '莲花街北苑菜鸟驿站',
    open_hours: '08:30 - 21:00',
    crowd_level: 'LOW',
    supports_self_pickup: true
  };
}
