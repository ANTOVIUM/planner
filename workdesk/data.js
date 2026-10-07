import {CONFIG} from './config.js';
import {validate} from './core.mjs';
export const db=window.supabase.createClient(CONFIG.url,CONFIG.key,{auth:{storageKey:'workdesk.auth.v1',persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}});
export async function load(){let result=[];for(let offset=0;;offset+=1000){const {data,error}=await db.from(CONFIG.table).select('*').order('id').range(offset,offset+999);if(error)throw error;result.push(...data);if(data.length<1000)return result;}}
export async function put(user,kind,data,old){
 validate(kind,data);
 const id=old?.id||crypto.randomUUID();
 const query=old?db.from(CONFIG.table).update({data,revision:old.revision+1,updated_at:new Date().toISOString()}).eq('id',id).eq('revision',old.revision):db.from(CONFIG.table).insert({id,user_id:user.id,kind,data,revision:1});
 const {data:out,error}=await query.select();if(error)throw error;if(!out.length)throw Error('Запись изменена на другом устройстве. Закрой форму, обнови кабинет и повтори изменение. Твой ввод остается в форме.');return out[0];
}
export async function remove(old){const {data,error}=await db.from(CONFIG.table).delete().eq('id',old.id).eq('revision',old.revision).select('id');if(error)throw error;if(!data.length)throw Error('Запись уже изменилась. Обнови кабинет.');}
