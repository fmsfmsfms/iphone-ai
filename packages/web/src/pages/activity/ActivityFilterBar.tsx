// Filters: free-text search, severity, actor, category chips and the task
// filter (set from a task link or the detail drawer).

import { FunnelXmark, Sparkles, Xmark } from '@gravity-ui/icons';
import type { ActivityCategory, ActivitySeverity, Actor } from '@iphone-ai/shared';
import { Button, Label, ListBox, SearchField, Select, Tag, TagGroup, type Key, type Selection } from '@heroui/react';

import { useI18n } from '../../lib/i18n';
import { ACTIVITY_ACTORS, ACTIVITY_CATEGORIES, ACTIVITY_SEVERITIES, hasActiveFilters, type ActivityFilters } from './helpers';
import { CATEGORY_ICON } from './meta';

export interface ActivityFilterBarProps {
  filters: ActivityFilters;
  searchInput: string;
  onSearchInput: (value: string) => void;
  onChange: (next: ActivityFilters) => void;
}

function MultiSelect<T extends string>({
  label,
  options,
  value,
  onChange,
  optionLabel,
}: {
  label: string;
  options: readonly T[];
  value: T[];
  onChange: (next: T[]) => void;
  optionLabel: (option: T) => string;
}) {
  const { t } = useI18n();
  const display =
    value.length === 0 ? t('activity.filters.any') : value.length === 1 ? optionLabel(value[0]!) : t('activity.filters.selected', { count: value.length });
  return (
    <Select
      selectionMode="multiple"
      value={value}
      onChange={(keys) => {
        const list = Array.isArray(keys) ? keys : keys === null ? [] : [keys];
        onChange(options.filter((o) => list.includes(o as Key)));
      }}
      variant="secondary"
      className="w-full min-w-0 sm:w-44"
    >
      <Label className="text-[11px] font-medium text-muted">{label}</Label>
      <Select.Trigger className="h-9">
        <Select.Value className={value.length === 0 ? 'text-muted' : ''}>{display}</Select.Value>
        <Select.Indicator />
      </Select.Trigger>
      <Select.Popover placement="bottom start">
        <ListBox selectionMode="multiple" aria-label={label}>
          {options.map((option) => (
            <ListBox.Item key={option} id={option} textValue={optionLabel(option)}>
              {optionLabel(option)}
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </Select.Popover>
    </Select>
  );
}

export function ActivityFilterBar({ filters, searchInput, onSearchInput, onChange }: ActivityFilterBarProps) {
  const { t } = useI18n();
  const active = hasActiveFilters(filters) || searchInput.trim().length > 0;

  const onCategories = (keys: Selection) => {
    const list = keys === 'all' ? [...ACTIVITY_CATEGORIES] : ACTIVITY_CATEGORIES.filter((c) => keys.has(c));
    onChange({ ...filters, categories: list });
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-2.5">
        <SearchField value={searchInput} onChange={onSearchInput} variant="secondary" className="min-w-56 flex-1" aria-label={t('activity.filters.search')}>
          <Label className="text-[11px] font-medium text-muted">{t('activity.filters.search')}</Label>
          <SearchField.Group className="h-9">
            <SearchField.SearchIcon />
            <SearchField.Input placeholder={t('activity.filters.searchPlaceholder')} maxLength={200} />
            <SearchField.ClearButton />
          </SearchField.Group>
        </SearchField>
        <MultiSelect<ActivitySeverity>
          label={t('activity.severity.label')}
          options={ACTIVITY_SEVERITIES}
          value={filters.severity}
          onChange={(severity) => onChange({ ...filters, severity })}
          optionLabel={(s) => t(`activity.severity.${s}`)}
        />
        <MultiSelect<Actor>
          label={t('activity.actor.label')}
          options={ACTIVITY_ACTORS}
          value={filters.actor}
          onChange={(actor) => onChange({ ...filters, actor })}
          optionLabel={(a) => t(`actor.${a}`)}
        />
        {active ? (
          <Button
            size="sm"
            variant="ghost"
            className="h-9"
            onPress={() => {
              onSearchInput('');
              onChange({ categories: [], severity: [], actor: [], search: '', taskId: null });
            }}
          >
            <FunnelXmark className="size-3.5" />
            {t('activity.filters.clear')}
          </Button>
        ) : null}
      </div>

      <TagGroup
        selectionMode="multiple"
        selectedKeys={new Set<Key>(filters.categories)}
        onSelectionChange={onCategories}
        size="sm"
        aria-label={t('activity.category.label')}
      >
        <TagGroup.List className="flex flex-wrap gap-1.5">
          {ACTIVITY_CATEGORIES.map((category: ActivityCategory) => (
            <Tag
              key={category}
              id={category}
              textValue={t(`activity.category.${category}`)}
              className="app-transition gap-1.5 data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground"
            >
              <span aria-hidden className="flex size-3.5 items-center justify-center [&>svg]:size-3.5">
                {CATEGORY_ICON[category]}
              </span>
              {t(`activity.category.${category}`)}
            </Tag>
          ))}
        </TagGroup.List>
      </TagGroup>

      {filters.taskId ? (
        <div className="ai-soft-bg flex flex-wrap items-center gap-2 rounded-xl border border-hairline px-3 py-2 text-[13px]">
          <Sparkles aria-hidden className="size-4 shrink-0 text-ai-purple" />
          <span className="flex items-center gap-1.5 font-medium text-foreground">
            {t('activity.detail.task')}
            <code dir="ltr" className="rounded bg-default px-1.5 py-0.5 font-mono text-[11px]">
              {filters.taskId}
            </code>
          </span>
          <span className="text-xs text-muted">{t('activity.filters.taskHint')}</span>
          <Button size="sm" variant="ghost" className="ms-auto" onPress={() => onChange({ ...filters, taskId: null })}>
            <Xmark className="size-3.5" />
            {t('activity.filters.removeTask')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
