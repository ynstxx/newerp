import { createApp } from 'vue'
import ElementPlus from 'element-plus'
import 'element-plus/dist/index.css'
// ponytail: 全量引入 EP（≈1MB gzip 前），要按需引入再上 unplugin-vue-components，现在不值当
import 'element-plus/theme-chalk/dark/css-vars.css'
import './theme.css'
import App from './App.vue'

createApp(App).use(ElementPlus).mount('#app')
