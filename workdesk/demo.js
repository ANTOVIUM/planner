import {dateISO,monthISO,CATEGORIES} from './core.mjs';
export function demoRecords(){
 const m=monthISO(),today=dateISO(),out=[],id=()=>crypto.randomUUID(),add=(kind,data,key=id())=>{out.push({id:key,kind,data,revision:1});return key;};
 const date=n=>`${m}-${String(n).padStart(2,'0')}`,day=+today.slice(-2);
 add('settings',{name:'Михаил',goal:80000,hourly:1200,weeklyHours:30,categories:CATEGORIES});
 const specs=[['Правовые задачи по наследству','Алексей','Правовые задачи',7800,780,4,180],['Финансовые расчеты в Excel','Ксения','Excel и расчеты',12000,1200,2,300],['Доклад и презентация','Анна','Презентации',9500,950,5,240],['Курсовая по гражданскому праву','Даниил','Курсовые работы',15000,1500,3,660]];
 for(const [title,client,category,price,fee,n,minutes] of specs){const key=add('order',{title,client,category,source:'Все сдал',url:'',notes:'Демонстрационная запись',price,fee,estimate:minutes/60,revisions:1,status:'done',date:date(1),deadline:date(n),deliveredDate:date(n),completedDate:date(n)});add('payment',{orderId:key,type:'receipt',amount:price-fee,date:date(n),notes:''});add('time',{orderId:key,type:'work',minutes,date:date(n),notes:''});if(n===3)add('time',{orderId:key,type:'rework',minutes:90,date:date(n),notes:'Правки по замечаниям'});}
 const key=add('order',{title:'Статья об электронных доказательствах',client:'Мария',category:'Статьи и доклады',source:'Все сдал',url:'',notes:'Уточнить оформление списка источников',price:8500,fee:850,estimate:6,revisions:0,status:'working',date:today,deadline:date(Math.min(day+2,28)),deliveredDate:'',completedDate:''});
 add('payment',{orderId:key,type:'receipt',amount:3000,date:today,notes:'Предоплата'});add('time',{orderId:key,type:'work',minutes:90,date:today,notes:'Поиск источников'});
 add('order',{title:'Отчет по производственной практике',client:'Яна',category:'Отчеты по практике',source:'Все сдал',url:'',notes:'',price:6500,fee:650,estimate:4,revisions:2,status:'revision',date:date(1),deadline:date(Math.max(1,day-1)),deliveredDate:'',completedDate:''});
 add('expense',{orderId:'',category:'Сервисы и подписки',amount:1800,date:date(1),notes:'Пример расхода'});add('expense',{orderId:key,category:'Проверка оригинальности',amount:400,date:today,notes:'Пример расхода'});
 add('task',{title:'Проверить источники для статьи',orderId:key,deadline:date(Math.min(day+1,28)),priority:'high',done:false,notes:''});add('task',{title:'Написать заказчику по оплате',orderId:'',deadline:today,priority:'normal',done:false,notes:''});
 return out;
}
