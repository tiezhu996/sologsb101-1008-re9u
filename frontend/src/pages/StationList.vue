<script setup lang="ts">
/**
 * /stations 换热站与楼栋台账
 * 新建换热站与楼栋，按供热方式与面积区间筛选，卡片回显失衡楼栋数与待复核单数。
 * 消费 Station、Building；复用 <StatBadge>、<EmptyPanel>、<FilterBar>。
 */
import { computed, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { MessagePlugin, DialogPlugin } from 'tdesign-vue-next'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import FilterBar from '@/components/common/FilterBar.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import { useStationStore } from '@/stores/stationStore'
import { useValveStore } from '@/stores/valveStore'
import { useAdjustStore } from '@/stores/adjustStore'
import { useImbalanceRank } from '@/hooks/useImbalanceRank'
import { useCapacityCheck } from '@/hooks/useCapacityCheck'
import { CAPACITY_TAG_THEME, excessPct } from '@/utils/capacity'
import type { BuildingCapacityCheck, CapacityStatus, StationCapacityCheck } from '@/types/capacity'
import {
  EMPTY_BUILDING_DRAFT,
  HEAT_MODES,
  type Building,
  type BuildingDraft,
  type HeatMode
} from '@/types/building'
import { EMPTY_STATION_DRAFT, formatArea, formatFlow, type Station, type StationDraft } from '@/types/station'

type FilterModel = { keyword: string; [key: string]: string | string[] | boolean }

const router = useRouter()
const stationStore = useStationStore()
const valveStore = useValveStore()
const adjustStore = useAdjustStore()
const rank = useImbalanceRank()
const capacity = useCapacityCheck()
const { stationChecks, checkOf, buildingCheckOf, overBuildingCount } = capacity

/* ------------------------------ 派生 ------------------------------ */

const valveCountOf = (stationId: string): number =>
  valveStore.valves.filter((valve) => valve.stationId === stationId).length

const imbalancedCountOf = (stationId: string): number =>
  rank.rows.value.filter((row) => row.valve.stationId === stationId && row.level !== '平衡').length

const pendingReviewOf = (stationId: string): number =>
  adjustStore.adjusts.filter((adjust) => {
    if (adjust.state === '已复核') return false
    const valve = valveStore.valves.find((item) => item.id === adjust.valveId)
    return valve ? valve.stationId === stationId : false
  }).length

const stationColumns = [
  { colKey: 'name', title: '楼栋', width: 140 },
  { colKey: 'area', title: '建筑面积', width: 120, cell: 'areaCell' },
  { colKey: 'floors', title: '层数', width: 80 },
  { colKey: 'units', title: '单元数', width: 90 },
  { colKey: 'heatMode', title: '供热方式', width: 110, cell: 'heatModeCell' },
  { colKey: 'valveCount', title: '阀门数', width: 90, cell: 'valveCountCell' },
  { colKey: 'capacity', title: '容量校核', width: 200, cell: 'capacityCell' },
  { colKey: 'op', title: '操作', width: 220, cell: 'opCell' }
]

function stationRowKey(row: Building): string {
  return row.id
}

/* ---------------------------- 容量校核展示 ---------------------------- */

const capacityColumns = [
  { colKey: 'buildingName', title: '楼栋', width: 150 },
  { colKey: 'area', title: '建筑面积', width: 110, cell: 'capacityAreaCell' },
  { colKey: 'areaSharePct', title: '面积占比', width: 100, cell: 'capacityShareCell' },
  { colKey: 'allocated', title: '分摊站流量', width: 120, cell: 'capacityAllocatedCell' },
  { colKey: 'valve', title: '阀门合计', width: 110, cell: 'capacityValveCell' },
  { colKey: 'excess', title: '超配量', width: 120, cell: 'capacityExcessCell' },
  { colKey: 'status', title: '结论', width: 100, cell: 'capacityStatusCell' },
  { colKey: 'skipReason', title: '说明', cell: 'capacityReasonCell' }
]

function capacityRowKey(row: BuildingCapacityCheck): string {
  return row.buildingId
}

function capacityRowClassName(row: BuildingCapacityCheck): string {
  return row.participating ? '' : 'capacity-row--skip'
}

function capacityTheme(status: CapacityStatus | null): 'danger' | 'primary' | 'success' | 'default' {
  return status ? CAPACITY_TAG_THEME[status] : 'default'
}

function flowText(value: number): string {
  return Number.isFinite(value) ? value.toFixed(1) : '—'
}

/** 超配量带正负号展示 */
function excessText(value: number): string {
  if (!Number.isFinite(value)) return '—'
  return `${value > 0 ? '+' : ''}${value.toFixed(1)}`
}

/** 未参与分摊楼栋下的阀门合计（全量口径与参与口径的差额说明用） */
function skippedValveTotal(check: StationCapacityCheck): number {
  return check.rows.filter((row) => !row.participating).reduce((sum, row) => sum + row.valveTotalM3h, 0)
}

/* ------------------------------ 筛选 ------------------------------ */

const filterModel = computed<FilterModel>(() => ({
  keyword: stationStore.keyword,
  heatMode: stationStore.heatModes
}))

const filterSelects = computed(() => [
  { key: 'heatMode', label: '供热方式', options: HEAT_MODES.map((item) => ({ label: item, value: item })) }
])

function onFilterChange(model: FilterModel): void {
  stationStore.keyword = String(model.keyword ?? '')
  stationStore.setHeatModes((Array.isArray(model.heatMode) ? model.heatMode : []) as HeatMode[])
}

const areaInput = reactive<{ from: number | null; to: number | null }>({
  from: stationStore.areaFrom,
  to: stationStore.areaTo
})

function applyAreaRange(): void {
  stationStore.setAreaRange(areaInput.from, areaInput.to)
}

/* ---------------------------- 换热站表单 ---------------------------- */

const stationDialogVisible = ref(false)
const stationDialogTitle = ref('新建换热站')
const stationForm = reactive<StationDraft>({ ...EMPTY_STATION_DRAFT })
const stationFormRef = ref()
let editingStationId: string | null = null

const stationRules = {
  name: [{ required: true, message: '请填写换热站名称', type: 'error' as const }],
  heatAreaM2: [{ required: true, message: '请填写供热面积', type: 'error' as const }],
  designFlowM3h: [{ required: true, message: '请填写设计流量', type: 'error' as const }]
}

function openCreateStation(): void {
  editingStationId = null
  stationDialogTitle.value = '新建换热站'
  Object.assign(stationForm, { ...EMPTY_STATION_DRAFT })
  stationDialogVisible.value = true
}

function openEditStation(station: Station): void {
  editingStationId = station.id
  stationDialogTitle.value = `编辑换热站 · ${station.name}`
  Object.assign(stationForm, {
    name: station.name,
    heatAreaM2: station.heatAreaM2,
    designFlowM3h: station.designFlowM3h,
    supplyTempC: station.supplyTempC,
    returnTempC: station.returnTempC,
    commissionYear: station.commissionYear
  })
  stationDialogVisible.value = true
}

async function submitStation(): Promise<void> {
  try {
    const result = await stationFormRef.value?.validate()
    if (result !== true) return
  } catch {
    return
  }
  if (editingStationId) {
    await stationStore.updateStation(editingStationId, { ...stationForm })
    MessagePlugin.success('换热站已更新')
  } else {
    await stationStore.createStation({ ...stationForm })
    MessagePlugin.success('换热站已创建，可继续登记楼栋')
  }
  stationDialogVisible.value = false
}

function removeStation(station: Station): void {
  const dialog = DialogPlugin.confirm({
    header: '删除确认',
    body: `删除换热站「${station.name}」将同时删除其下楼栋、阀门、实测与调节单，确认删除？`,
    confirmBtn: '确认删除',
    cancelBtn: '取消',
    onConfirm: async () => {
      await stationStore.removeStation(station.id)
      MessagePlugin.success('换热站及其下游数据已删除')
      dialog.destroy()
    }
  })
}

/* ----------------------------- 楼栋表单 ----------------------------- */

const buildingDialogVisible = ref(false)
const buildingDialogTitle = ref('登记楼栋')
const buildingForm = reactive<BuildingDraft>({ ...EMPTY_BUILDING_DRAFT })
const buildingFormRef = ref()
let editingBuildingId: string | null = null

const buildingRules = {
  name: [{ required: true, message: '请填写楼栋名称', type: 'error' as const }],
  areaM2: [{ required: true, message: '请填写建筑面积', type: 'error' as const }]
}

function openCreateBuilding(): void {
  if (!stationStore.currentStationId) {
    MessagePlugin.warning('请先选择或新建一个换热站')
    return
  }
  editingBuildingId = null
  buildingDialogTitle.value = `登记楼栋 · ${stationStore.currentStation?.name ?? ''}`
  Object.assign(buildingForm, { ...EMPTY_BUILDING_DRAFT, stationId: stationStore.currentStationId })
  buildingDialogVisible.value = true
}

function openEditBuilding(building: Building): void {
  editingBuildingId = building.id
  buildingDialogTitle.value = `编辑楼栋 · ${building.name}`
  Object.assign(buildingForm, {
    stationId: building.stationId,
    name: building.name,
    areaM2: building.areaM2,
    floors: building.floors,
    units: building.units,
    heatMode: building.heatMode
  })
  buildingDialogVisible.value = true
}

async function submitBuilding(): Promise<void> {
  try {
    const result = await buildingFormRef.value?.validate()
    if (result !== true) return
  } catch {
    return
  }
  if (editingBuildingId) {
    await stationStore.updateBuilding(editingBuildingId, { ...buildingForm })
    MessagePlugin.success('楼栋已更新')
  } else {
    await stationStore.createBuilding({ ...buildingForm })
    MessagePlugin.success('楼栋已登记')
  }
  buildingDialogVisible.value = false
}

function removeBuilding(building: Building): void {
  const dialog = DialogPlugin.confirm({
    header: '删除确认',
    body: `删除楼栋「${building.name}」将同时删除其阀门与实测记录，确认删除？`,
    confirmBtn: '确认删除',
    cancelBtn: '取消',
    onConfirm: async () => {
      await stationStore.removeBuilding(building.id)
      MessagePlugin.success('楼栋及其下游数据已删除')
      dialog.destroy()
    }
  })
}

/* ------------------------------ 跳转 ------------------------------ */

function goValves(stationId: string): void {
  valveStore.patchFilter({ stationId, keyword: '' })
  void router.push('/valves')
}
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h2 class="page-head__title">换热站与楼栋台账</h2>
        <p class="page-head__desc">
          先建换热站再登记楼栋；卡片回显失衡楼栋数与待复核调节单数，两侧联动切换。
        </p>
      </div>
      <div class="page-head__actions">
        <t-button theme="primary" @click="openCreateStation">新建换热站</t-button>
        <t-button variant="outline" :disabled="!stationStore.currentStationId" @click="openCreateBuilding">
          登记楼栋
        </t-button>
      </div>
    </div>

    <div class="stat-row">
      <StatBadge label="换热站" :value="stationStore.stations.length" suffix="座" tone="primary" />
      <StatBadge label="楼栋" :value="stationStore.buildings.length" suffix="栋" tone="info" />
      <StatBadge label="阀门" :value="valveStore.valves.length" suffix="只" tone="default" />
      <StatBadge
        label="严重失衡占比"
        :value="rank.summary.value.severe"
        :percent="rank.summary.value.severePercent"
        suffix="只"
        tone="danger"
      />
      <StatBadge
        label="容量超配楼栋"
        :value="overBuildingCount"
        suffix="栋"
        tone="warning"
      />
    </div>

    <FilterBar
      :model-value="filterModel"
      :selects="filterSelects"
      keyword-placeholder="搜索换热站 / 楼栋名称"
      @change="onFilterChange"
    />

    <div class="grid-two" style="margin-top: 16px">
      <div class="panel">
        <h3 class="panel-title">换热站列表（{{ stationStore.filteredStations.length }}）</h3>
        <EmptyPanel
          v-if="stationStore.filteredStations.length === 0"
          title="还没有换热站"
          description="新建换热站后即可登记楼栋与阀门。"
          action-text="新建换热站"
          compact
          @action="openCreateStation"
        />
        <div
          v-for="station in stationStore.filteredStations"
          :key="station.id"
          class="card-list-item"
          :class="{ 'is-active': station.id === stationStore.currentStationId }"
          @click="stationStore.selectStation(station.id)"
        >
          <div class="card-list-item__head">
            <span>{{ station.name }}</span>
            <t-tag size="small" variant="light" theme="primary">{{ station.commissionYear }} 年投运</t-tag>
          </div>
          <div class="card-list-item__meta">
            <span>{{ formatArea(station.heatAreaM2) }}</span>
            <span>· 设计 {{ formatFlow(station.designFlowM3h) }}</span>
            <span>· {{ station.supplyTempC }}/{{ station.returnTempC }} ℃</span>
          </div>
          <div class="card-list-item__meta">
            <span>楼栋 {{ stationStore.buildingsOf(station.id).length }}</span>
            <span>· 阀门 {{ valveCountOf(station.id) }}</span>
            <span :style="{ color: imbalancedCountOf(station.id) > 0 ? '#c0392b' : undefined }">
              · 失衡 {{ imbalancedCountOf(station.id) }}
            </span>
            <span>· 待复核 {{ pendingReviewOf(station.id) }}</span>
          </div>
          <div v-if="checkOf(station.id)" class="card-list-item__meta capacity-chip">
            <template v-if="checkOf(station.id)?.checkable">
              <span>容量校核：</span>
              <t-tag
                size="small"
                :theme="capacityTheme(checkOf(station.id)?.status ?? null)"
                variant="light"
              >
                {{ checkOf(station.id)?.status }}
              </t-tag>
              <span>
                阀门合计 {{ flowText(checkOf(station.id)?.stationValveTotalM3h ?? 0) }} /
                站能力 {{ flowText(station.designFlowM3h) }}
              </span>
              <span
                v-if="checkOf(station.id)?.status === '超配'"
                :style="{ color: '#c0392b', fontWeight: 600 }"
              >
                ⚠ 超配 {{ excessText(checkOf(station.id)?.stationExcessM3h ?? 0) }} m³/h
                （{{ excessPct(checkOf(station.id)?.stationExcessM3h ?? 0, station.designFlowM3h) }}%）
              </span>
            </template>
            <t-tag v-else size="small" theme="default" variant="light">容量不可校核</t-tag>
            <span class="muted">{{ checkOf(station.id)?.skipReason }}</span>
          </div>
          <div class="card-list-item__meta" style="gap: 8px">
            <t-button size="small" variant="text" theme="primary" @click.stop="openEditStation(station)">
              编辑
            </t-button>
            <t-button size="small" variant="text" theme="danger" @click.stop="removeStation(station)">删除</t-button>
            <t-button size="small" variant="text" theme="primary" @click.stop="goValves(station.id)">
              该站阀门
            </t-button>
          </div>
        </div>
      </div>

      <div class="panel">
        <div class="panel-head">
          <h3 class="panel-title" style="margin: 0">
            楼栋明细
            <span v-if="stationStore.currentStation" class="muted">· {{ stationStore.currentStation.name }}</span>
          </h3>
          <div class="toolbar">
            <t-input-number
              v-model="areaInput.from"
              :min="0"
              :step="500"
              placeholder="面积起"
              style="width: 128px"
              @blur="applyAreaRange"
            />
            <span class="muted">～</span>
            <t-input-number
              v-model="areaInput.to"
              :min="0"
              :step="500"
              placeholder="面积止"
              style="width: 128px"
              @blur="applyAreaRange"
            />
            <t-button size="small" variant="outline" @click="stationStore.resetFilter(); areaInput.from = null; areaInput.to = null">
              重置筛选
            </t-button>
          </div>
        </div>

        <EmptyPanel
          v-if="stationStore.filteredBuildings.length === 0"
          title="该条件下没有楼栋"
          description="调整供热方式或面积区间，或直接登记一栋新楼栋。"
          action-text="登记楼栋"
          compact
          @action="openCreateBuilding"
        />

        <t-table
          v-else
          :data="stationStore.filteredBuildings"
          :columns="stationColumns"
          :row-key="stationRowKey"
          bordered
          stripe
          size="small"
        >
          <template #areaCell="{ row }">{{ formatArea(row.areaM2) }}</template>
          <template #heatModeCell="{ row }">
            <t-tag size="small" :theme="row.heatMode === '地暖' ? 'success' : 'warning'" variant="light">
              {{ row.heatMode }}
            </t-tag>
          </template>
          <template #valveCountCell="{ row }">
            {{ valveStore.valves.filter((valve) => valve.buildingId === row.id).length }}
          </template>
          <template #capacityCell="{ row }">
            <template v-if="buildingCheckOf(row.stationId, row.id) as BuildingCapacityCheck">
              <template
                v-if="(buildingCheckOf(row.stationId, row.id) as BuildingCapacityCheck).participating"
              >
                <t-tag
                  size="small"
                  :theme="capacityTheme((buildingCheckOf(row.stationId, row.id) as BuildingCapacityCheck).status)"
                  variant="light"
                >
                  {{ (buildingCheckOf(row.stationId, row.id) as BuildingCapacityCheck).status }}
                </t-tag>
                <span class="muted">
                  {{ excessText((buildingCheckOf(row.stationId, row.id) as BuildingCapacityCheck).excessM3h) }}
                </span>
              </template>
              <span v-else class="muted">
                {{ (buildingCheckOf(row.stationId, row.id) as BuildingCapacityCheck).skipReason }}
              </span>
            </template>
          </template>
          <template #opCell="{ row }">
            <div class="toolbar">
              <t-button size="small" variant="text" theme="primary" @click="openEditBuilding(row)">编辑</t-button>
              <t-button size="small" variant="text" theme="danger" @click="removeBuilding(row)">删除</t-button>
              <t-button size="small" variant="text" theme="primary" @click="goValves(row.stationId)">阀门</t-button>
            </div>
          </template>
        </t-table>
      </div>
    </div>

    <div class="panel capacity-panel">
      <div class="panel-head">
        <h3 class="panel-title" style="margin: 0">换热站容量校核</h3>
        <span class="muted">
          校核口径以换热站设计流量为准：按楼栋建筑面积占比分摊站能力，再与该楼阀门设计流量合计比较；
          阀门设计流量为现场参数原样保留，不反向覆盖站值
        </span>
      </div>

      <EmptyPanel
        v-if="stationChecks.length === 0"
        title="还没有换热站"
        description="新建换热站并登记楼栋、阀门后，将自动按面积分摊站设计流量并提示超配。"
        action-text="新建换热站"
        compact
        @action="openCreateStation"
      />

      <div
        v-for="check in stationChecks"
        :key="check.stationId"
        class="capacity-card"
        :class="{ 'is-active': check.stationId === stationStore.currentStationId }"
      >
        <div class="capacity-card__head">
          <div class="toolbar" style="gap: 10px">
            <strong>{{ check.stationName }}</strong>
            <t-tag
              v-if="check.checkable"
              size="small"
              :theme="capacityTheme(check.status)"
              variant="light"
            >
              整站{{ check.status }}
            </t-tag>
            <t-tag v-else size="small" theme="default" variant="light">不可校核</t-tag>
          </div>
          <div class="toolbar capacity-card__meta">
            <span class="muted">站设计流量 {{ flowText(check.designFlowM3h) }} m³/h</span>
            <span
              v-if="check.checkable"
              class="muted"
            >参与分摊面积 {{ formatArea(check.participatingAreaM2) }}（{{ check.participatingBuildingCount }}/{{ check.buildingCount }} 栋）</span>
            <span class="muted">阀门 {{ check.stationValveCount }} 只</span>
            <span
              v-if="check.checkable"
              :style="{ color: check.status === '超配' ? '#c0392b' : undefined, fontWeight: check.status === '超配' ? 600 : 400 }"
            >
              阀门合计 {{ flowText(check.stationValveTotalM3h) }} m³/h，
              {{ check.status === '超配' ? '超配' : check.status === '低配' ? '缺口' : '差额' }}
              {{ excessText(check.stationExcessM3h) }}
              m³/h（{{ excessPct(check.stationExcessM3h, check.designFlowM3h) }}%）
            </span>
          </div>
        </div>

        <t-alert
          v-if="!check.checkable"
          theme="warning"
          :message="check.skipReason"
          style="margin-bottom: 10px"
        />
        <t-alert
          v-else-if="check.status === '超配'"
          theme="error"
          :message="`站内阀门设计流量合计超出站能力 ${excessText(check.stationExcessM3h)} m³/h，扩容登记后已无上限余量，请复核阀门配置或站设计流量。`"
          style="margin-bottom: 10px"
        />

        <t-table
          :data="check.rows"
          :columns="capacityColumns"
          :row-key="capacityRowKey"
          :row-class-name="capacityRowClassName"
          bordered
          stripe
          size="small"
        >
          <template #capacityAreaCell="{ row }">{{ formatArea(row.areaM2) }}</template>
          <template #capacityShareCell="{ row }">
            <span v-if="row.participating">{{ row.areaSharePct.toFixed(2) }}%</span>
            <span v-else class="muted">—</span>
          </template>
          <template #capacityAllocatedCell="{ row }">
            <span v-if="row.participating">{{ flowText(row.allocatedFlowM3h) }}</span>
            <span v-else class="muted">—</span>
          </template>
          <template #capacityValveCell="{ row }">
            {{ flowText(row.valveTotalM3h) }}
            <span class="muted">/ {{ row.valveCount }} 只</span>
          </template>
          <template #capacityExcessCell="{ row }">
            <span
              v-if="row.participating"
              :style="{ color: row.status === '超配' ? '#c0392b' : row.status === '低配' ? '#2b6cb0' : undefined }"
            >
              {{ excessText(row.excessM3h) }}
            </span>
            <span v-else class="muted">—</span>
          </template>
          <template #capacityStatusCell="{ row }">
            <t-tag v-if="row.status" size="small" :theme="capacityTheme(row.status)" variant="light">
              {{ row.status }}
            </t-tag>
            <t-tag v-else size="small" theme="default" variant="light">不参与</t-tag>
          </template>
          <template #capacityReasonCell="{ row }">
            <span class="muted">{{ row.skipReason || '—' }}</span>
          </template>
        </t-table>

        <p v-if="check.checkable && skippedValveTotal(check) > 0" class="muted capacity-note">
          注：未参与分摊楼栋下的阀门合计 {{ flowText(skippedValveTotal(check)) }} m³/h，已计入整站阀门合计，但不参与面积分摊比较。
        </p>
      </div>
    </div>

    <t-dialog
      v-model:visible="stationDialogVisible"
      :header="stationDialogTitle"
      width="560px"
      :confirm-btn="'保存'"
      :cancel-btn="'取消'"
      @confirm="submitStation"
    >
      <t-form ref="stationFormRef" :data="stationForm" :rules="stationRules" label-width="128px">
        <t-form-item label="换热站名称" name="name">
          <t-input v-model="stationForm.name" placeholder="如 阳光家园换热站" />
        </t-form-item>
        <t-form-item label="供热面积(m²)" name="heatAreaM2">
          <t-input-number v-model="stationForm.heatAreaM2" :min="0" :step="1000" style="width: 100%" />
        </t-form-item>
        <t-form-item label="设计流量(m³/h)" name="designFlowM3h">
          <t-input-number v-model="stationForm.designFlowM3h" :min="0" :step="10" style="width: 100%" />
        </t-form-item>
        <t-form-item label="设计供水温度" name="supplyTempC">
          <t-input-number v-model="stationForm.supplyTempC" :min="0" :step="1" style="width: 100%" />
        </t-form-item>
        <t-form-item label="设计回水温度" name="returnTempC">
          <t-input-number v-model="stationForm.returnTempC" :min="0" :step="1" style="width: 100%" />
        </t-form-item>
        <t-form-item label="投运年份" name="commissionYear">
          <t-input-number v-model="stationForm.commissionYear" :min="1980" :max="2100" style="width: 100%" />
        </t-form-item>
      </t-form>
    </t-dialog>

    <t-dialog
      v-model:visible="buildingDialogVisible"
      :header="buildingDialogTitle"
      width="560px"
      :confirm-btn="'保存'"
      :cancel-btn="'取消'"
      @confirm="submitBuilding"
    >
      <t-form ref="buildingFormRef" :data="buildingForm" :rules="buildingRules" label-width="128px">
        <t-form-item label="所属换热站">
          <t-input :value="stationStore.currentStation ? stationStore.currentStation.name : ''" disabled />
        </t-form-item>
        <t-form-item label="楼栋名称" name="name">
          <t-input v-model="buildingForm.name" placeholder="如 3号楼 / A座" />
        </t-form-item>
        <t-form-item label="建筑面积(m²)" name="areaM2">
          <t-input-number v-model="buildingForm.areaM2" :min="0" :step="100" style="width: 100%" />
        </t-form-item>
        <t-form-item label="层数" name="floors">
          <t-input-number v-model="buildingForm.floors" :min="1" style="width: 100%" />
        </t-form-item>
        <t-form-item label="单元数" name="units">
          <t-input-number v-model="buildingForm.units" :min="1" style="width: 100%" />
        </t-form-item>
        <t-form-item label="供热方式" name="heatMode">
          <t-radio-group v-model="buildingForm.heatMode" variant="default-filled">
            <t-radio-button v-for="item in HEAT_MODES" :key="item" :value="item">{{ item }}</t-radio-button>
          </t-radio-group>
        </t-form-item>
      </t-form>
    </t-dialog>
  </div>
</template>

<style scoped>
.capacity-chip {
  gap: 8px;
  align-items: center;
}

.capacity-panel {
  margin-top: 16px;
}

.capacity-card {
  padding: 14px;
  border: 1px solid var(--hg-line);
  border-radius: 10px;
  background: #fff;
  margin-bottom: 14px;
}

.capacity-card.is-active {
  border-color: var(--hg-accent);
  box-shadow: 0 0 0 2px rgba(193, 68, 14, 0.12);
}

.capacity-card__head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 10px;
}

.capacity-card__meta {
  gap: 10px;
}

.capacity-note {
  margin: 8px 0 0;
}

:deep(.capacity-row--skip) {
  color: var(--hg-ink-soft);
  background: #faf7f2;
}
</style>
