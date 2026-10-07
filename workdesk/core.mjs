export const STATUSES={new:'Новый',working:'В работе',revision:'Доработка',delivered:'Сдан',done:'Завершен',cancelled:'Отменен'};
export const CATEGORIES=['Курсовые работы','Дипломы и ВКР','Правовые задачи','Статьи и доклады','Презентации','Excel и расчеты','Отчеты по практике','Другие работы'];
export const DEFAULTS={name:'Мой кабинет',goal:0,hourly:0,weeklyHours:30,categories:CATEGORIES};
export const round=n=>Math.round((n+Number.EPSILON)*100)/100;
export const dateISO=(d=new Date())=>new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Saratov',year:'numeric',month:'2-digit',day:'2-digit'}).format(d);
export const monthISO=()=>dateISO().slice(0,7);
export const rub=n=>new Intl.NumberFormat('ru-RU',{style:'currency',currency:'RUB',minimumFractionDigits:0,maximumFractionDigits:2}).format(n||0);
export const num=n=>new Intl.NumberFormat('ru-RU',{maximumFractionDigits:1}).format(n||0);
export const validDate=s=>/^\d{4}-\d{2}-\d{2}$/.test(s)&&!Number.isNaN(Date.parse(s))&&new Date(s).toISOString().slice(0,10)===s;
export const isActive=o=>['new','working','revision'].includes(o.status);
export const inMonth=(d,m)=>!!d&&(!m||d.slice(0,7)===m);
const sum=(a,f)=>round(a.reduce((s,x)=>s+f(x),0));
export function rows(records,kind){return records.filter(r=>r.kind===kind).map(r=>({...r.data,id:r.id,revision:r.revision}));}
export function orderStats(o,records){
 const payments=rows(records,'payment').filter(p=>p.orderId===o.id),expenses=rows(records,'expense').filter(e=>e.orderId===o.id),time=rows(records,'time').filter(t=>t.orderId===o.id);
 const net=round(o.price-o.fee),received=sum(payments,p=>p.type==='refund'?-p.amount:p.amount),cost=sum(expenses,e=>e.amount),minutes=sum(time,t=>t.minutes),rework=sum(time.filter(t=>t.type==='rework'),t=>t.minutes),profit=round(net-cost);
 return {net,received,cost,minutes,rework,profit,outstanding:o.status==='cancelled'?0:round(Math.max(0,net-received)),rate:minutes?round(profit/(minutes/60)):null};
}
export function metrics(records,month,today=dateISO()){
 const orders=rows(records,'order'),payments=rows(records,'payment').filter(p=>inMonth(p.date,month)),expenses=rows(records,'expense').filter(e=>inMonth(e.date,month)),time=rows(records,'time').filter(t=>inMonth(t.date,month));
 const completed=orders.filter(o=>o.status==='done'&&inMonth(o.completedDate,month));
 const revenue=sum(payments,p=>p.type==='refund'?-p.amount:p.amount),cost=sum(expenses,e=>e.amount),minutes=sum(time,t=>t.minutes),rework=sum(time.filter(t=>t.type==='rework'),t=>t.minutes);
 const earned=sum(completed,o=>orderStats(o,records).profit),outstanding=sum(orders,o=>orderStats(o,records).outstanding);
 const timely=orders.filter(o=>o.deliveredDate&&inMonth(o.deliveredDate,month)&&o.deadline);
 return {revenue,cost,cash:round(revenue-cost),earned,outstanding,minutes,rework,rate:minutes?round((revenue-cost)/(minutes/60)):null,completed:completed.length,active:orders.filter(isActive),overdue:orders.filter(o=>isActive(o)&&o.deadline<today),onTime:timely.length?Math.round(100*timely.filter(o=>o.deliveredDate<=o.deadline).length/timely.length):null};
}
export function categoryStats(records,month){
 const orders=rows(records,'order').filter(o=>o.status==='done'&&inMonth(o.completedDate,month));
 return [...new Set(orders.map(o=>o.category))].map(category=>{
  const group=orders.filter(o=>o.category===category),stats=group.map(o=>orderStats(o,records)),profit=sum(stats,s=>s.profit),minutes=sum(stats,s=>s.minutes);
  return {category,count:group.length,profit,minutes,rate:minutes&&stats.every(s=>s.minutes>0)?round(profit/(minutes/60)):null,average:round(profit/group.length)};
 }).sort((a,b)=>(b.rate??-Infinity)-(a.rate??-Infinity));
}
export function dailySeries(records,month){
 const days=new Date(+month.slice(0,4),+month.slice(5,7),0).getDate(),payments=rows(records,'payment'),expenses=rows(records,'expense');
 return Array.from({length:days},(_,i)=>{const date=`${month}-${String(i+1).padStart(2,'0')}`;return {day:i+1,income:sum(payments.filter(p=>p.date===date),p=>p.type==='refund'?-p.amount:p.amount),expense:sum(expenses.filter(e=>e.date===date),e=>e.amount)};});
}
export function validate(kind,d){
 const text=(key,max=500,required=false)=>{if(typeof d[key]!=='string'||d[key].length>max||(required&&!d[key].trim()))throw Error('Проверь поле: '+key);};
 const amount=(key,max=1e9)=>{if(typeof d[key]!=='number'||!Number.isFinite(d[key])||d[key]<0||d[key]>max)throw Error('Укажи корректное неотрицательное число: '+key);};
 const date=(key,required=true)=>{if((required||d[key])&&!validDate(d[key]))throw Error('Проверь дату: '+key);};
 if(!d||typeof d!=='object'||Array.isArray(d))throw Error('Некорректная запись');
 if(kind==='order'){text('title',250,true);text('client',250);text('category',100,true);text('source',100);text('notes',10000);text('url',2000);amount('price');amount('fee');amount('estimate',100000);amount('revisions',10000);if(d.fee>d.price)throw Error('Комиссия не может превышать стоимость');if(!STATUSES[d.status])throw Error('Некорректный статус');date('date');date('deadline');date('completedDate',false);date('deliveredDate',false);if(d.status==='done'&&!d.completedDate)throw Error('Укажи дату завершения');if(d.url&&!/^https?:\/\//i.test(d.url))throw Error('Ссылка должна начинаться с https:// или http://');}
 else if(['payment','expense','time'].includes(kind)){text('orderId',36);text('notes',2000);date('date');if(kind==='time'){amount('minutes',1440);if(!d.minutes||!['work','rework'].includes(d.type))throw Error('Укажи длительность от 1 минуты и вид работы');}else {amount('amount');if(!d.amount)throw Error('Сумма должна быть больше нуля');if(kind==='payment'&&(!d.orderId||!['receipt','refund'].includes(d.type)))throw Error('Выбери заказ и вид платежа');if(kind==='expense')text('category',100,true);}}
 else if(kind==='task'){text('title',250,true);text('notes',2000);text('orderId',36);date('deadline');if(!['high','normal','low'].includes(d.priority)||typeof d.done!=='boolean')throw Error('Проверь параметры задачи');}
 else if(kind==='settings'){text('name',100,true);amount('goal');amount('hourly');amount('weeklyHours',168);if(!Array.isArray(d.categories)||!d.categories.length||d.categories.length>50||d.categories.some(x=>typeof x!=='string'||!x.trim()||x.length>100))throw Error('Укажи от 1 до 50 категорий');}
 else throw Error('Неизвестный тип записи');
 return d;
}
export function csv(records){
 const safe=v=>'"'+(typeof v==='number'?String(v).replace('.',','):String(v??'').replace(/^[\s]*[=+@\-]/,"'$&")).replaceAll('"','""')+'"';
 const header=['Заказ','Клиент','Категория','Статус','Стоимость','Комиссия','Расходы','Получено','Ожидается','Прибыль до налогов','Часы','Прибыль за час','Срок'];
 const data=rows(records,'order').map(o=>{const s=orderStats(o,records);return [o.title,o.client,o.category,STATUSES[o.status],o.price,o.fee,s.cost,s.received,s.outstanding,s.profit,round(s.minutes/60),s.rate??'',o.deadline];});
 return '\uFEFF'+[header,...data].map(r=>r.map(safe).join(';')).join('\r\n');
}
