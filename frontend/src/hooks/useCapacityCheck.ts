/**
 * 容量校核：随换热站 / 楼栋 / 阀门数据实时重算。
 * 被换热站台账页消费；面积、阀门归属或阀门设计流量变化后，整站分摊与
 * 超配提示通过 computed 自动同步更新，无需手动刷新。
 */
import { computed, type ComputedRef } from 'vue'
import { useStationStore } from '@/stores/stationStore'
import { useValveStore } from '@/stores/valveStore'
import { checkStationCapacity } from '@/utils/capacity'
import type { StationCapacityCheck } from '@/types/capacity'

export interface UseCapacityCheckResult {
  /** 按换热站逐站校核，顺序与 stationStore.stations 一致 */
  stationChecks: ComputedRef<StationCapacityCheck[]>
  checkOf: (stationId: string) => StationCapacityCheck | null
  buildingCheckOf: (stationId: string, buildingId: string) => StationCapacityCheck['rows'][number] | null
  /** 存在超配楼栋的换热站数 */
  overStationCount: ComputedRef<number>
  /** 全量超配楼栋数 */
  overBuildingCount: ComputedRef<number>
}

export function useCapacityCheck(): UseCapacityCheckResult {
  const stationStore = useStationStore()
  const valveStore = useValveStore()

  const stationChecks = computed<StationCapacityCheck[]>(() =>
    stationStore.stations.map((station) => {
      const stationBuildings = stationStore.buildings.filter((building) => building.stationId === station.id)
      const stationValves = valveStore.valves.filter((valve) => valve.stationId === station.id)
      return checkStationCapacity(station, stationBuildings, stationValves)
    })
  )

  function checkOf(stationId: string): StationCapacityCheck | null {
    return stationChecks.value.find((item) => item.stationId === stationId) ?? null
  }

  function buildingCheckOf(
    stationId: string,
    buildingId: string
  ): StationCapacityCheck['rows'][number] | null {
    const station = checkOf(stationId)
    return station ? station.rows.find((row) => row.buildingId === buildingId) ?? null : null
  }

  const overStationCount = computed(
    () => stationChecks.value.filter((item) => item.status === '超配').length
  )

  const overBuildingCount = computed(() =>
    stationChecks.value.reduce((sum, item) => sum + item.overBuildingCount, 0)
  )

  return { stationChecks, checkOf, buildingCheckOf, overStationCount, overBuildingCount }
}
