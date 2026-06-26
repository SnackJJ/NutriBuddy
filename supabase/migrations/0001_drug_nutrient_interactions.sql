-- 药物-营养素相互作用规则表（issue #9 / PRD v2 §3.1「硬约束规则」）。
-- pre/post-gate 的硬约束数据源：代码层确定性查询，零 LLM 依赖。
-- 查询入口见 src/lib/drugInteractions.ts。
--
-- 来源：NIH Office of Dietary Supplements (ODS) 与 MedlinePlus（NIH/NLM）。
-- 每条规则标注其权威来源；severity=high 者应在 post-gate 硬拦。

create table if not exists drug_nutrient_interactions (
  id            bigint generated always as identity primary key,
  drug_name     text not null,
  nutrient      text not null,
  food_examples text[] not null default '{}',
  severity      text not null check (severity in ('high', 'moderate', 'low')),
  source        text not null,
  created_at    timestamptz not null default now(),
  unique (drug_name, nutrient)
);

-- 按药名查询是 pre-gate 的热路径。
create index if not exists idx_dni_drug_name
  on drug_nutrient_interactions (drug_name);

-- 种子数据：覆盖最常见的药物-营养素相互作用。drug_name 一律小写通用名，
-- 与 src/lib/drugInteractions.ts 的 normalizeDrug 约定一致。
insert into drug_nutrient_interactions (drug_name, nutrient, food_examples, severity, source) values
  ('warfarin', 'vitamin K', array['kale', 'spinach', 'broccoli', 'brussels sprouts', 'collard greens'], 'high', 'NIH ODS'),
  ('warfarin', 'vitamin E', array['wheat germ oil', 'sunflower seeds', 'almonds', 'high-dose supplements'], 'moderate', 'NIH ODS'),
  ('warfarin', 'cranberry', array['cranberry juice', 'cranberry supplements'], 'moderate', 'MedlinePlus'),
  ('phenelzine', 'tyramine', array['aged cheese', 'cured meats', 'soy sauce', 'sauerkraut', 'draft beer'], 'high', 'MedlinePlus'),
  ('tranylcypromine', 'tyramine', array['aged cheese', 'smoked fish', 'fermented soy', 'salami', 'tap beer'], 'high', 'MedlinePlus'),
  ('isocarboxazid', 'tyramine', array['aged cheese', 'cured meats', 'soy sauce', 'miso', 'fava beans'], 'high', 'MedlinePlus'),
  ('isoniazid', 'tyramine', array['aged cheese', 'cured meats', 'smoked fish'], 'moderate', 'MedlinePlus'),
  ('metformin', 'alcohol', array['beer', 'wine', 'spirits'], 'moderate', 'MedlinePlus'),
  ('simvastatin', 'grapefruit', array['grapefruit', 'grapefruit juice'], 'high', 'NIH ODS'),
  ('atorvastatin', 'grapefruit', array['grapefruit', 'grapefruit juice'], 'moderate', 'MedlinePlus'),
  ('levothyroxine', 'calcium', array['milk', 'yogurt', 'cheese', 'calcium supplements'], 'moderate', 'MedlinePlus'),
  ('levothyroxine', 'iron', array['red meat', 'iron supplements', 'fortified cereals'], 'moderate', 'MedlinePlus'),
  ('levothyroxine', 'soy', array['soy milk', 'tofu', 'edamame', 'soy protein'], 'low', 'NIH ODS'),
  ('lisinopril', 'potassium', array['banana', 'potato', 'orange', 'tomato', 'spinach', 'salt substitutes'], 'moderate', 'MedlinePlus'),
  ('enalapril', 'potassium', array['banana', 'potato', 'avocado', 'white beans', 'salt substitutes'], 'moderate', 'MedlinePlus'),
  ('spironolactone', 'potassium', array['banana', 'potato', 'orange juice', 'salt substitutes'], 'high', 'MedlinePlus'),
  ('tetracycline', 'calcium', array['milk', 'cheese', 'yogurt', 'calcium-fortified juice'], 'moderate', 'MedlinePlus'),
  ('tetracycline', 'iron', array['red meat', 'iron supplements', 'fortified cereals'], 'moderate', 'MedlinePlus'),
  ('ciprofloxacin', 'calcium', array['dairy products', 'calcium-fortified foods', 'supplements'], 'moderate', 'MedlinePlus'),
  ('ciprofloxacin', 'iron', array['iron supplements', 'fortified cereals'], 'moderate', 'MedlinePlus'),
  ('digoxin', 'licorice', array['black licorice', 'licorice tea'], 'moderate', 'MedlinePlus'),
  ('digoxin', 'fiber', array['wheat bran', 'psyllium', 'high-fiber supplements'], 'low', 'MedlinePlus'),
  ('lithium', 'sodium', array['salty foods', 'cured meats', 'salt intake changes'], 'high', 'MedlinePlus'),
  ('methotrexate', 'folate', array['folic acid supplements', 'fortified cereals'], 'moderate', 'NIH ODS'),
  ('phenytoin', 'folate', array['folic acid supplements', 'leafy greens'], 'moderate', 'NIH ODS'),
  ('alendronate', 'calcium', array['milk', 'dairy', 'calcium supplements', 'mineral water'], 'moderate', 'MedlinePlus');
