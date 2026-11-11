import { createApp } from 'vue'
import { createPinia } from 'pinia'
import ElementPlus from 'element-plus'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import 'element-plus/dist/index.css'
import App from './App.vue'
import './style.css'

createApp(App)
  .use(createPinia())
  // 全量引入 Element Plus：按需引入要配 unplugin，多一层构建工具，
  // 而这套界面本来就重度使用它的弹窗/表单/消息，全量反而省心
  .use(ElementPlus, { locale: zhCn })
  .mount('#app')
