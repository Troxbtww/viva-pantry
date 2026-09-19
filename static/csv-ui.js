/* Import a food database through the same private item API used by the editor. */
'use strict';
let csvImportBusy=false;

function csvFoodKey(item){
  return [item.name.trim().toLocaleLowerCase(),item.package_size??'',item.package_unit,item.pack_count||1].join('|');
}
function openCSVImport(){
  let rows=[];
  document.querySelector('#small-content').innerHTML=`<header class="dialog-header"><div><h2 id="small-title">Bring your food list.</h2><p>Import a food database CSV, then add photos when you’re ready.</p></div><button class="icon-button" data-action="close-small" aria-label="Close CSV import">${icon('close')}</button></header>
  <div class="dialog-body"><label class="button secondary" for="csv-file" tabindex="0" role="button">${icon('document')}Choose a CSV</label><input class="hidden-file" id="csv-file" type="file" accept=".csv,text/csv">
  <label class="field" style="margin-top:18px"><span>Source filename</span><input id="csv-filename" value="Food database.csv" maxlength="150"></label>
  <label class="field" style="margin-top:14px"><span>CSV contents</span><textarea id="csv-text" rows="5" placeholder="Choose a file above, or paste the CSV text here." spellcheck="false"></textarea></label>
  <p class="form-help">Supports the Food, Package qty, Package unit, Nutrition basis qty and nutrient columns from a food database export. Undated prices stay in notes until you confirm an observation date. Existing matching foods are skipped.</p>
  <button class="button secondary" id="csv-preview" type="button">Review foods</button><div id="csv-status" class="photo-status" role="status"></div><div id="csv-preview-rows"></div></div>
  <footer class="dialog-footer"><div class="dialog-footer-actions"><button class="button secondary" data-action="close-small">Close</button><button class="button primary" id="csv-save" type="button" disabled>Import selected foods</button></div></footer>`;
  const textInput=document.querySelector('#csv-text'),filename=document.querySelector('#csv-filename'),fileInput=document.querySelector('#csv-file');
  const status=document.querySelector('#csv-status'),preview=document.querySelector('#csv-preview-rows'),save=document.querySelector('#csv-save');
  const invalidate=()=>{rows=[];preview.innerHTML='';status.textContent='';save.disabled=true;};
  textInput.addEventListener('input',invalidate);filename.addEventListener('input',invalidate);
  fileInput.addEventListener('change',async()=>{
    const file=fileInput.files[0];if(!file)return;
    invalidate();
    if(file.size>2*1024*1024){status.textContent='Choose a CSV smaller than 2 MB.';return;}
    try{textInput.value=await file.text();filename.value=file.name;}catch{status.textContent='The file could not be read. Try pasting its CSV contents.';}
    fileInput.value='';
  });
  document.querySelector('#csv-preview').addEventListener('click',()=>{
    invalidate();
    try{
      rows=window.PantryCSV.parse(textInput.value,filename.value||'Food database.csv');
      const seen=new Set(state.items.map(csvFoodKey));
      preview.innerHTML=rows.map((row,index)=>{
        row.skip=seen.has(csvFoodKey(row.item));seen.add(csvFoodKey(row.item));
        return `<div class="csv-food-row"><label><input type="checkbox" data-csv-row="${index}" ${row.skip?'disabled':'checked'}><span><strong>${e(row.item.name)}</strong><small>${e(packageText(row.item))} · ${e(row.item.nutrition.basis)}</small></span></label>${row.skip?'<p class="form-help">Already in this library or repeated in this file.</p>':''}<details><summary>Nutrition and source notes</summary><p class="form-help">${row.item.nutrition.values.map(v=>`${e(v.label)}: ${e(v.value)} ${e(v.unit)}`).join(' · ')}</p><p class="item-notes">${e(row.item.notes)}</p>${row.warnings.length?`<p class="form-help">${row.warnings.map(e).join(' · ')}</p>`:''}</details></div>`;
      }).join('');
      status.textContent=`${rows.length} foods found. Nutrition and reference prices remain marked for your review. Photos can be added later.`;
      save.disabled=!rows.some(row=>!row.skip);
    }catch(err){status.innerHTML=errorBox(err.message);}
  });
  save.addEventListener('click',async()=>{
    if(csvImportBusy)return;
    const selected=[...preview.querySelectorAll('input[data-csv-row]:checked')].map(input=>rows[Number(input.dataset.csvRow)]);
    if(!selected.length){status.textContent='Select at least one food to import.';return;}
    csvImportBusy=true;
    smallDialog.querySelectorAll('button,input,textarea').forEach(control=>{control.disabled=true;});
    let saved=0,skipped=0,failed=false;
    try{
      await refreshItems();
      const known=new Set(state.items.map(csvFoodKey));
      for(const row of selected){
        const key=csvFoodKey(row.item);
        if(known.has(key)){skipped++;continue;}
        status.textContent=`Importing ${saved+skipped+1} of ${selected.length}: ${row.item.name}…`;
        const item=await api('/api/items',{method:'POST',body:JSON.stringify(row.item)});
        state.items.push(item);known.add(key);saved++;
      }
      await refreshItems();
      status.textContent=`${saved} foods imported${skipped?`; ${skipped} already present and skipped`:''}. You can now add photos and check each food.`;
      preview.innerHTML='';rows=[];
    }catch(err){
      failed=true;
      status.innerHTML=errorBox(`${saved} foods imported before the import stopped: ${err.message} Click Import selected foods to retry; saved matches will be skipped.`);
    }finally{
      csvImportBusy=false;
      smallDialog.querySelectorAll('button,input,textarea').forEach(control=>{control.disabled=false;});
      preview.querySelectorAll('input[data-csv-row]').forEach(input=>{if(rows[Number(input.dataset.csvRow)].skip)input.disabled=true;});
      save.disabled=!failed;
      updateCounts();if((location.hash||'#library')==='#library')renderLibrary();
    }
  });
  smallDialog.showModal();
}
smallDialog.addEventListener('cancel',event=>{if(csvImportBusy)event.preventDefault();});
