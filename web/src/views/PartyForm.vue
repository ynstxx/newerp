<script setup>
import { reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { api, fieldErrors } from '../api.js'
import { t } from '../i18n.js'

const props = defineProps({
  /** @type {{ id: string, version: number } | null} */
  party: { type: Object, default: null },
})
const emit = defineEmits(['saved'])
const visible = defineModel({ type: Boolean, default: false })

const empty = () => ({
  code: '',
  name: '',
  partyType: 'customer',
  taxNo: '',
  contactName: '',
  phone: '',
  email: '',
  addr: '',
  status: 'active',
  remark: '',
})

const form = reactive(empty())
const busy = ref(false)

watch(visible, (open) => {
  if (!open) return
  Object.assign(form, empty(), props.party ? { ...props.party } : {})
})

async function save() {
  busy.value = true
  try {
    const payload = { ...form }
    delete payload.id
    delete payload.version
    if (props.party) {
      await api.patch(`/api/parties/${props.party.id}`, { ...payload, version: props.party.version })
    } else {
      await api.post('/api/parties', payload)
    }
    ElMessage.success(t('action.saved'))
    visible.value = false
    emit('saved')
  } catch (err) {
    ElMessage.error(fieldErrors(err))
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <el-drawer v-model="visible" :title="props.party ? t('party.edit') : t('party.new')" size="420px" data-test="party-drawer">
    <el-form label-position="top">
      <el-form-item :label="t('party.code')" required>
        <el-input v-model="form.code" maxlength="64" data-test="f-code" />
      </el-form-item>
      <el-form-item :label="t('party.name')" required>
        <el-input v-model="form.name" maxlength="64" data-test="f-name" />
      </el-form-item>
      <el-form-item :label="t('party.type')" required>
        <el-select v-model="form.partyType" style="width: 100%" data-test="f-type">
          <el-option v-for="k in ['customer', 'supplier', 'both']" :key="k" :value="k" :label="t(`type.${k}`)" />
        </el-select>
      </el-form-item>
      <el-form-item :label="t('party.status')">
        <el-select v-model="form.status" style="width: 100%">
          <el-option v-for="k in ['active', 'disabled']" :key="k" :value="k" :label="t(`status.${k}`)" />
        </el-select>
      </el-form-item>
      <el-form-item :label="t('party.taxNo')">
        <el-input v-model="form.taxNo" maxlength="32" />
      </el-form-item>
      <el-form-item :label="t('party.contact')">
        <el-input v-model="form.contactName" maxlength="32" data-test="f-contact" />
      </el-form-item>
      <el-form-item :label="t('party.phone')">
        <el-input v-model="form.phone" maxlength="32" />
      </el-form-item>
      <el-form-item :label="t('party.email')">
        <el-input v-model="form.email" />
      </el-form-item>
      <el-form-item :label="t('party.addr')">
        <el-input v-model="form.addr" type="textarea" :rows="2" maxlength="200" />
      </el-form-item>
      <el-form-item :label="t('party.remark')">
        <el-input v-model="form.remark" type="textarea" :rows="2" maxlength="500" />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="visible = false">{{ t('action.cancel') }}</el-button>
      <el-button type="primary" :loading="busy" data-test="f-save" @click="save">{{ t('action.save') }}</el-button>
    </template>
  </el-drawer>
</template>
