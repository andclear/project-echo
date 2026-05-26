import { app } from 'electron'
import { join } from 'path'

// 强行死锁 app 名称与用户数据目录，彻底根治不同开发与运行环境下的物理路径飘移与数据丢失 Bug！
app.name = 'project-echo'
const expectedUserDataPath = join(app.getPath('appData'), 'project-echo')
app.setPath('userData', expectedUserDataPath)

console.log(`[AppUserDataLock] 物理用户数据路径已成功统一死锁为: ${expectedUserDataPath}`)
